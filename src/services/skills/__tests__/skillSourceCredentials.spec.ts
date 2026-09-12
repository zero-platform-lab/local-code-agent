// npx vitest run services/skills/__tests__/skillSourceCredentials.spec.ts
//
// HTTPS の取得元の資格情報を git の保管庫へ預ける層。
//
// 本製品は値を保持しない。保持しない代わりに、渡し方の制約が効いていることを
// ここで確かめる。標準入力以外へ載せると、`.git/config` や `ps` や子プロセスの
// 環境に残る。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import {
	buildCredentialApproveInput,
	credentialTargetForUrl,
	defaultCredentialDeps,
	hasCredentialHelper,
	isSafeCredentialValue,
	storeSkillSourceCredentials,
	type CredentialDeps,
} from "../skillSourceCredentials"

describe("credentialTargetForUrl", () => {
	it.each([
		["https://gitlab.example.com/platform/skills.git", "https", "gitlab.example.com"],
		["http://gitlab.example.com/a", "http", "gitlab.example.com"],
		["https://gitlab.example.com:8443/a", "https", "gitlab.example.com:8443"],
		["https://user@gitlab.example.com/a", "https", "gitlab.example.com"],
		["  https://GitLab.Example.COM/a  ", "https", "gitlab.example.com"],
	])("%s の宛先はホストだけ", (url, protocol, host) => {
		expect(credentialTargetForUrl(url)).toEqual({ protocol, host })
	})

	it.each(["git@gitlab.example.com:a/b.git", "ssh://git@host/a", "gitlab.example.com/a", "", "https://@/a"])(
		"%s は預ける宛先にならない",
		(url) => {
			expect(credentialTargetForUrl(url)).toBeUndefined()
		},
	)
})

describe("isSafeCredentialValue", () => {
	it.each(["token", "", "パスワード", "a b"])("%s は受け付ける", (value) => {
		expect(isSafeCredentialValue(value)).toBe(true)
	})

	it.each([["x\nhost=evil"], ["x\r"], ["x\0y"]])("%j は拒む", (value) => {
		// 改行から先が別の項目として読まれ、別のホストの資格情報にされる。
		expect(isSafeCredentialValue(value)).toBe(false)
	})
})

describe("buildCredentialApproveInput", () => {
	it("1 行 1 項目で、空行で閉じる", () => {
		const input = buildCredentialApproveInput({ protocol: "https", host: "gitlab.example.com" }, "u", "p")

		expect(input).toBe("protocol=https\nhost=gitlab.example.com\nusername=u\npassword=p\n\n")
	})
})

describe("hasCredentialHelper", () => {
	it.each([["store\n"], ["manager\ncache\n"], [" store "]])("%j は保管庫がある", (output) => {
		expect(hasCredentialHelper(output)).toBe(true)
	})

	it.each([[""], ["\n"], ["  \n  \n"]])("%j は保管庫が無い", (output) => {
		expect(hasCredentialHelper(output)).toBe(false)
	})
})

describe("storeSkillSourceCredentials", () => {
	const deps = (overrides: Partial<CredentialDeps> = {}): CredentialDeps => ({
		readCredentialHelpers: async () => "store\n",
		approve: async () => {},
		...overrides,
	})

	it("SSH の取得元では預けない", async () => {
		// 既定の依存のまま呼ぶ。宛先にならないので git は起動しない。
		const result = await storeSkillSourceCredentials({
			url: "git@gitlab.example.com:a/b.git",
			username: "u",
			password: "p",
		})

		expect(result).toEqual({ ok: false, reason: "not-https" })
	})

	it.each([
		["利用者名", "u\nhost=evil", "p"],
		["パスワード", "u", "p\nhost=evil"],
	])("%s に改行があれば預けない", async (_label, username, password) => {
		const approve = vi.fn()

		const result = await storeSkillSourceCredentials(
			{ url: "https://gitlab.example.com/a", username, password },
			deps({ approve }),
		)

		expect(result).toEqual({ ok: false, reason: "unsafe-value" })
		expect(approve).not.toHaveBeenCalled()
	})

	it("保管庫が無いときは預けずに知らせる（FR-EXT-06c）", async () => {
		const approve = vi.fn()

		const result = await storeSkillSourceCredentials(
			{ url: "https://gitlab.example.com/a", username: "u", password: "p" },
			deps({ readCredentialHelpers: async () => "", approve }),
		)

		expect(result).toEqual({ ok: false, reason: "no-helper" })
		// 預けられないまま次の取得が失敗する。黙って進めない。
		expect(approve).not.toHaveBeenCalled()
	})

	it("標準入力の中身だけで預ける（FR-EXT-06b）", async () => {
		const approve = vi.fn()

		const result = await storeSkillSourceCredentials(
			{ url: "https://gitlab.example.com:8443/platform/skills.git", username: "u", password: "t0ken" },
			deps({ approve }),
		)

		expect(result).toEqual({ ok: true, host: "gitlab.example.com:8443" })
		expect(approve).toHaveBeenCalledWith(
			"protocol=https\nhost=gitlab.example.com:8443\nusername=u\npassword=t0ken\n\n",
		)
	})

	it("預けられなかったときは、資格情報を伏せて返す（FR-EXT-06e）", async () => {
		const result = await storeSkillSourceCredentials(
			{ url: "https://gitlab.example.com/a", username: "u", password: "p" },
			deps({
				approve: async () => {
					throw new Error("fatal: https://u:t0ken@gitlab.example.com/a へ届かない")
				},
			}),
		)

		expect(result).toEqual({
			ok: false,
			reason: "failed",
			error: "fatal: https://<伏せた>@gitlab.example.com/a へ届かない",
		})
	})

	it("Error でないものを投げられても返す", async () => {
		const result = await storeSkillSourceCredentials(
			{ url: "https://gitlab.example.com/a", username: "u", password: "p" },
			deps({
				approve: async () => {
					throw "こわれた"
				},
			}),
		)

		expect(result).toEqual({ ok: false, reason: "failed", error: "こわれた" })
	})
})

describe("defaultCredentialDeps", () => {
	// 本物の git を起動する。設定は `GIT_CONFIG_*` で渡すので、利用者の設定を書き換えない。
	const originalEnv = { ...process.env }

	afterEach(() => {
		process.env = { ...originalEnv }
	})

	const withGitConfig = (pairs: [string, string][]) => {
		process.env.GIT_CONFIG_COUNT = String(pairs.length)
		pairs.forEach(([key, value], index) => {
			process.env[`GIT_CONFIG_KEY_${index}`] = key
			process.env[`GIT_CONFIG_VALUE_${index}`] = value
		})
	}

	it("設定されている保管庫を読む", async () => {
		withGitConfig([["credential.helper", "store"]])

		expect(await defaultCredentialDeps.readCredentialHelpers()).toBe("store\n")
	})

	it("保管庫が未設定なら空を返す。git が 1 で終わっても例外にしない", async () => {
		withGitConfig([["credential.helper", ""]])

		expect(await defaultCredentialDeps.readCredentialHelpers()).toBe("\n")
	})

	it("預けた値が保管庫へ渡る", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-credentials-"))
		const store = path.join(dir, "credentials")
		withGitConfig([["credential.helper", `store --file=${store}`]])

		await defaultCredentialDeps.approve(
			buildCredentialApproveInput({ protocol: "https", host: "gitlab.example.com" }, "u", "t0ken"),
		)

		expect(await fs.readFile(store, "utf8")).toContain("https://u:t0ken@gitlab.example.com")
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("git が受け取れない入力なら失敗として返す", async () => {
		await expect(defaultCredentialDeps.approve("こわれた入力\n\n")).rejects.toThrow(
			/git credential approve が .* で終わりました/,
		)
	})

	it("git が見つからなければ失敗として返す", async () => {
		process.env.PATH = ""

		await expect(defaultCredentialDeps.readCredentialHelpers()).rejects.toThrow()
	})
})
