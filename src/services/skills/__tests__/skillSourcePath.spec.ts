// npx vitest run services/skills/__tests__/skillSourcePath.spec.ts

import * as path from "path"

import { parseSkillSourceUrl } from "../skillSourcePath"

const ok = (url: string) => {
	const result = parseSkillSourceUrl(url)
	if (!result.valid) throw new Error(`解釈できるはずの URL が拒否された: ${url} (${result.error})`)
	return result.value
}

const ng = (url: string) => {
	const result = parseSkillSourceUrl(url)
	if (result.valid) throw new Error(`拒否されるはずの URL が通った: ${url}`)
	return result.error
}

describe("parseSkillSourceUrl", () => {
	describe("置き場所は URL から機械的に決まる（FR-EXT-05c1）", () => {
		it("HTTPS と SSH の同じリポジトリが、同じ置き場所になる", () => {
			const https = ok("https://gitlab.example.com/platform/skills.git")
			const ssh = ok("git@gitlab.example.com:platform/skills.git")

			expect(https.directory).toBe(ssh.directory)
			expect(https.directory).toBe(path.join("gitlab.example.com", "platform", "skills"))
		})

		it("末尾の `.git` の有無で置き場所が変わらない", () => {
			expect(ok("https://host/a/b.git").directory).toBe(ok("https://host/a/b").directory)
		})

		it("ホスト名の大文字小文字で置き場所が変わらない", () => {
			expect(ok("https://GitLab.Example.COM/a/b").directory).toBe(ok("https://gitlab.example.com/a/b").directory)
		})

		it("入れ子のグループをそのまま段にする", () => {
			expect(ok("https://host/platform/team/skills").segments).toEqual(["platform", "team", "skills"])
		})

		it("既定でないポートは置き場所に残す。同じホストの別ポートを混ぜない", () => {
			const a = ok("ssh://git@host:2222/a/b")
			const b = ok("ssh://git@host/a/b")

			expect(a.host).toBe("host_2222")
			expect(b.host).toBe("host")
			expect(a.directory).not.toBe(b.directory)
		})
	})

	describe("経路の判別（FR-EXT-05b3）", () => {
		it.each([
			["https://host/a/b", "https"],
			["http://host/a/b", "https"],
			["ssh://git@host/a/b", "ssh"],
			["git@host:a/b", "ssh"],
			["host:a/b", "ssh"],
		])("%s は %s と判別する", (url, transport) => {
			expect(ok(url).transport).toBe(transport)
		})
	})

	describe("受け付けない URL（FR-EXT-05c2）", () => {
		it.each([
			["上へ抜ける", "https://host/a/../../etc"],
			["現在位置", "https://host/a/./b"],
			["SSH でも上へ抜ける", "git@host:../../etc"],
		])("%s: %s", (_label, url) => {
			expect(ng(url)).toContain("`..`")
		})

		it.each([
			["パスに使えない文字", "https://host/a/b%3Ac"],
			["パスに制御文字", "https://host/a/b%01c"],
		])("%s: %s", (_label, url) => {
			expect(ng(url)).toContain("使えない文字")
		})

		it.each([
			["空", ""],
			["空白だけ", "   "],
			["形式が違う", "not a url"],
			["パスが無い", "https://host"],
			["パスが区切りだけ", "https://host///"],
		])("%s: %s", (_label, url) => {
			expect(ng(url)).toBeTruthy()
		})

		it.each([
			["ポートが数字でない", "https://host:abc/a/b"],
			["ホストが空", "https:///a/b"],
			["ホストに使えない文字", "ho*st:a/b"],
		])("%s: %s", (_label, url) => {
			expect(ng(url)).toContain("ホスト名")
		})

		it("リポジトリ名が `.git` だけのときを拒む", () => {
			expect(ng("https://host/a/.git")).toContain("リポジトリ名")
		})

		it("解釈できない百分率の並びを拒む", () => {
			expect(ng("https://host/a/%E0%A4%A")).toBeTruthy()
		})
	})

	it("前後の空白を落として解釈する", () => {
		expect(ok("  https://host/a/b  ").directory).toBe(path.join("host", "a", "b"))
	})
})
