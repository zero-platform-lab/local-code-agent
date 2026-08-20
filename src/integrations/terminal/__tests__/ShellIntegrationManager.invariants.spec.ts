// npx vitest run integrations/terminal/__tests__/ShellIntegrationManager.invariants.spec.ts
//
// ShellIntegrationManager は zsh のシェル統合のために **一時 ZDOTDIR を作り、
// 後で消す** クラス。C0 11.3%（未実行 86 行）で、生成側（writeFile）も削除側
// （unlinkSync / rmdirSync）もまったく試されていなかった。
//
// ここで固定する最重要の不変条件は 1 点:
//
//   **削除するのは自分が作った一時ディレクトリだけ。**
//   fs.unlinkSync / fs.rmdirSync に渡る全パスが os.tmpdir() 配下であること。
//
// zshCleanupTmpDir が消すのは `<tmpDir>/.zshrc` と `<tmpDir>` そのもの。ここが
// ずれると利用者の `~/.zshrc` が黙って消える（unlinkSync に確認は無い）。
// terminalTmpDirs は public static な Map なので「zshInitTmpDir が入れた値しか
// 無いはず」は前提でしかなく、前提が破れたときに止めるのは削除側の責務。
// そこで
//   - 通常フロー（zshInitTmpDir → terminalTmpDirs → zshCleanupTmpDir）では
//     削除パスの「全件」が tmpdir 配下であること
//   - tmpdir の外のパスが入っていたら fs へ削除依頼が 1 件も飛ばないこと
// の両方を検査する。
//
// fs は完全にモックし、実ファイルには一切触れない。

import * as os from "os"
import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- モック ------------------------------------------------------------------

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn((..._a: unknown[]) => true),
	unlinkSync: vi.fn((..._a: unknown[]) => undefined),
	rmdirSync: vi.fn((..._a: unknown[]) => undefined),
}))

// 実ファイルを絶対に消さないための最後の砦。
vi.mock("fs", () => ({ ...fsMock, default: fsMock }))

const vscodeMock = vi.hoisted(() => ({
	createDirectory: vi.fn(async (..._a: unknown[]) => undefined),
	writeFile: vi.fn(async (..._a: unknown[]) => undefined),
}))

vi.mock("vscode", () => ({
	workspace: {
		fs: {
			createDirectory: vscodeMock.createDirectory,
			writeFile: vscodeMock.writeFile,
		},
	},
	Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	env: { appRoot: "/vscode/app-root" },
}))

import { ShellIntegrationManager } from "../ShellIntegrationManager"

// --- ヘルパ ------------------------------------------------------------------

const TMP_ROOT = path.resolve(os.tmpdir())

/** 一時ディレクトリの生成・削除まわりのログは大量に出るので黙らせる。 */
let infoSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

/** マイクロタスク（zshInitTmpDir の .then チェーン）を全部流す。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** fs へ削除依頼が飛んだパスを、呼ばれた順に全件返す。 */
function deletedPaths(): string[] {
	return [
		...fsMock.unlinkSync.mock.calls.map((call) => String(call[0])),
		...fsMock.rmdirSync.mock.calls.map((call) => String(call[0])),
	]
}

/**
 * **最重要の不変条件**: 削除依頼が飛んだ全パスが os.tmpdir() の「配下」であること。
 *
 * tmpdir そのものや、その親が渡っていないことも見る。rmdirSync は非再帰なので
 * 空でないディレクトリなら失敗するが、unlinkSync のほうは中身を問わず消すので、
 * `<HOME>/.zshrc` のようなパスが 1 件でも通れば復元手段が無い。
 */
function expectAllDeletionsInsideTmp(label: string): void {
	for (const p of deletedPaths()) {
		const resolved = path.resolve(p)
		expect(resolved.startsWith(TMP_ROOT + path.sep), `${label}: ${p} が tmpdir 配下でない`).toBe(true)
		expect(resolved, `${label}: tmpdir 自体を消そうとしている`).not.toBe(TMP_ROOT)
		expect(resolved, `${label}: tmpdir の親を消そうとしている`).not.toBe(path.dirname(TMP_ROOT))
	}
}

const originalZdotdir = process.env.ZDOTDIR

beforeEach(() => {
	vi.clearAllMocks()
	fsMock.existsSync.mockImplementation(() => true)
	fsMock.unlinkSync.mockImplementation(() => undefined)
	fsMock.rmdirSync.mockImplementation(() => undefined)
	vscodeMock.createDirectory.mockImplementation(async () => undefined)
	vscodeMock.writeFile.mockImplementation(async () => undefined)
	ShellIntegrationManager.terminalTmpDirs.clear()
	delete process.env.ZDOTDIR
	infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	infoSpy.mockRestore()
	errorSpy.mockRestore()
	if (originalZdotdir === undefined) {
		delete process.env.ZDOTDIR
	} else {
		process.env.ZDOTDIR = originalZdotdir
	}
})

// --- 1. 一時ディレクトリの生成 ------------------------------------------------

describe("ShellIntegrationManager.zshInitTmpDir", () => {
	it("os.tmpdir() 配下に roo-zdotdir-* を作り、そのパスを返す", async () => {
		const env: Record<string, string> = {}

		const tmpDir = ShellIntegrationManager.zshInitTmpDir(env)

		expect(path.dirname(tmpDir)).toBe(os.tmpdir())
		expect(path.basename(tmpDir)).toMatch(/^roo-zdotdir-[a-z0-9]+$/)
		expect(vscodeMock.createDirectory).toHaveBeenCalledExactlyOnceWith({
			fsPath: tmpDir,
			path: tmpDir,
			scheme: "file",
		})
		await flush()
	})

	it("呼ぶたびに別のディレクトリになる（使い回さない）", async () => {
		const a = ShellIntegrationManager.zshInitTmpDir({})
		const b = ShellIntegrationManager.zshInitTmpDir({})

		expect(a).not.toBe(b)
		await flush()
	})

	it("既存の ZDOTDIR は ROO_ZDOTDIR に退避する", async () => {
		process.env.ZDOTDIR = "/home/someone/zdot"
		const env: Record<string, string> = {}

		ShellIntegrationManager.zshInitTmpDir(env)

		expect(env.ROO_ZDOTDIR).toBe("/home/someone/zdot")
		await flush()
	})

	it("ZDOTDIR が無ければ ROO_ZDOTDIR は生やさない", async () => {
		const env: Record<string, string> = {}

		ShellIntegrationManager.zshInitTmpDir(env)

		expect("ROO_ZDOTDIR" in env).toBe(false)
		await flush()
	})

	it("ディレクトリ作成後に .zshrc を書き、シェル統合スクリプトを source する", async () => {
		const tmpDir = ShellIntegrationManager.zshInitTmpDir({})

		await flush()

		expect(vscodeMock.writeFile).toHaveBeenCalledTimes(1)
		const [uri, buffer] = vscodeMock.writeFile.mock.calls[0] as [{ fsPath: string }, Buffer]
		// .zshrc の書き込み先も一時ディレクトリ配下。
		expect(uri.fsPath).toBe(`${tmpDir}/.zshrc`)
		expect(path.resolve(uri.fsPath).startsWith(TMP_ROOT + path.sep)).toBe(true)

		const content = buffer.toString()
		expect(content).toContain(
			`source "${path.join("/vscode/app-root", "out", "vs", "workbench", "contrib", "terminal", "common", "scripts", "shellIntegration-rc.zsh")}"`,
		)
		// 退避した ZDOTDIR を復元して元の rc を読み直す
		expect(content).toContain("ZDOTDIR=${ROO_ZDOTDIR:-$HOME}")
		expect(content).toContain("unset ROO_ZDOTDIR")
		expect(content).toContain('[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"')
	})

	it(".zshrc の書き込みに失敗しても例外を投げず、ログだけ出す", async () => {
		vscodeMock.writeFile.mockRejectedValueOnce(new Error("EACCES"))

		ShellIntegrationManager.zshInitTmpDir({})
		await flush()

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Error creating .zshrc file"))
	})

	it("ディレクトリ作成に失敗したら .zshrc を書きに行かない", async () => {
		vscodeMock.createDirectory.mockRejectedValueOnce(new Error("EROFS"))

		ShellIntegrationManager.zshInitTmpDir({})
		await flush()

		expect(vscodeMock.writeFile).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Error creating temporary directory"))
	})
})

// --- 2. 一時ディレクトリの削除（最重要の不変条件） ----------------------------

describe("ShellIntegrationManager.zshCleanupTmpDir", () => {
	it("登録されていない terminalId では fs を一切触らず false を返す", () => {
		expect(ShellIntegrationManager.zshCleanupTmpDir(999)).toBe(false)

		expect(fsMock.existsSync).not.toHaveBeenCalled()
		expect(fsMock.unlinkSync).not.toHaveBeenCalled()
		expect(fsMock.rmdirSync).not.toHaveBeenCalled()
	})

	it("**生成 → 登録 → 削除 の通常フローで、消すのは自分の一時ディレクトリだけ**", async () => {
		// 実運用の経路（Terminal のコンストラクタ）と同じ形で map に登録する。
		const tmpDir = ShellIntegrationManager.zshInitTmpDir({})
		await flush()
		ShellIntegrationManager.terminalTmpDirs.set(1, tmpDir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(1)).toBe(true)

		// 消したのはちょうど 2 つ、順に .zshrc → ディレクトリ本体。
		expect(fsMock.unlinkSync).toHaveBeenCalledExactlyOnceWith(path.join(tmpDir, ".zshrc"))
		expect(fsMock.rmdirSync).toHaveBeenCalledExactlyOnceWith(tmpDir)
		expect(deletedPaths()).toEqual([path.join(tmpDir, ".zshrc"), tmpDir])
		expectAllDeletionsInsideTmp("通常フロー")
		// 後片付け後は map から消える。
		expect(ShellIntegrationManager.terminalTmpDirs.has(1)).toBe(false)
	})

	it("**複数ターミナルを一括で片付けても、削除パスは全件 tmpdir 配下**", async () => {
		for (let id = 1; id <= 5; id++) {
			const dir = ShellIntegrationManager.zshInitTmpDir({})
			ShellIntegrationManager.terminalTmpDirs.set(id, dir)
		}
		await flush()

		ShellIntegrationManager.clear()

		expect(deletedPaths()).toHaveLength(10)
		expectAllDeletionsInsideTmp("clear()")
		expect(ShellIntegrationManager.terminalTmpDirs.size).toBe(0)
	})

	it(".zshrc が無ければ unlinkSync は呼ばない（ディレクトリだけ消す）", () => {
		const tmpDir = path.join(os.tmpdir(), "roo-zdotdir-only-dir")
		ShellIntegrationManager.terminalTmpDirs.set(7, tmpDir)
		fsMock.existsSync.mockImplementation((p: unknown) => p === tmpDir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(7)).toBe(true)

		expect(fsMock.unlinkSync).not.toHaveBeenCalled()
		expect(fsMock.rmdirSync).toHaveBeenCalledExactlyOnceWith(tmpDir)
		expectAllDeletionsInsideTmp(".zshrc 無し")
	})

	it("何も残っていなければ削除は 1 度も走らないが true を返す", () => {
		const tmpDir = path.join(os.tmpdir(), "roo-zdotdir-gone")
		ShellIntegrationManager.terminalTmpDirs.set(8, tmpDir)
		fsMock.existsSync.mockImplementation(() => false)

		expect(ShellIntegrationManager.zshCleanupTmpDir(8)).toBe(true)

		expect(deletedPaths()).toEqual([])
		expect(ShellIntegrationManager.terminalTmpDirs.has(8)).toBe(false)
	})

	it("**二重解放しても壊れない：2 回目は false を返し、fs を触らない**", () => {
		const tmpDir = path.join(os.tmpdir(), "roo-zdotdir-double")
		ShellIntegrationManager.terminalTmpDirs.set(9, tmpDir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(9)).toBe(true)
		const afterFirst = deletedPaths().length

		expect(ShellIntegrationManager.zshCleanupTmpDir(9)).toBe(false)

		expect(deletedPaths()).toHaveLength(afterFirst)
	})

	it("削除中に例外が出たら false を返し、map からは消さない（再試行できる）", () => {
		const tmpDir = path.join(os.tmpdir(), "roo-zdotdir-ebusy")
		ShellIntegrationManager.terminalTmpDirs.set(10, tmpDir)
		fsMock.rmdirSync.mockImplementation(() => {
			throw new Error("ENOTEMPTY: directory not empty")
		})

		expect(ShellIntegrationManager.zshCleanupTmpDir(10)).toBe(false)

		expect(ShellIntegrationManager.terminalTmpDirs.get(10)).toBe(tmpDir)
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ENOTEMPTY: directory not empty"))
	})

	it("Error 以外が投げられても String 化して握り潰す", () => {
		const tmpDir = path.join(os.tmpdir(), "roo-zdotdir-weird")
		ShellIntegrationManager.terminalTmpDirs.set(11, tmpDir)
		fsMock.unlinkSync.mockImplementation(() => {
			throw "not-an-error"
		})

		expect(ShellIntegrationManager.zshCleanupTmpDir(11)).toBe(false)

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not-an-error"))
	})

	it.each([
		// [ラベル, map に入っているパス]
		// 実害が最大の形。ここが通ると利用者の `~/.zshrc` が消える。
		["ホームディレクトリ", os.homedir()],
		["ホーム直下のディレクトリ", path.join(os.homedir(), "zdot")],
		["ルート", path.parse(TMP_ROOT).root],
		["tmpdir の親", path.dirname(TMP_ROOT)],
		["無関係な絶対パス", path.join(path.sep, "home", "victim")],
		// 素朴な startsWith だと通ってしまう形（セパレータ境界）。
		["tmpdir と接頭辞だけ一致する兄弟", `${TMP_ROOT}-evil`],
		// path.resolve で正規化してから比べないと通ってしまう形。
		["tmpdir から `..` で抜ける", path.join(TMP_ROOT, "..", "etc")],
		["正規化前は tmpdir 配下に見えるパス", [TMP_ROOT, "roo-zdotdir-x", "..", "..", "etc"].join(path.sep)],
		// 相対パスは process.cwd() 基準で解決される＝tmpdir 配下ではない。
		["相対パス", "roo-zdotdir-relative"],
		// 「配下」の判定だけだと通ってしまう形。tmpdir 自身が入ると
		// `<tmpdir>/.zshrc` が unlink される（rmdir は非空なら失敗するが unlink は成功しうる）。
		["tmpdir そのもの", TMP_ROOT],
		["tmpdir そのもの（末尾セパレータ付き）", TMP_ROOT + path.sep],
	])("**【不変条件】%s が map に入っていても、fs へ削除依頼を 1 件も出さない**", (label, outside) => {
		ShellIntegrationManager.terminalTmpDirs.set(12, outside)

		expect(ShellIntegrationManager.zshCleanupTmpDir(12)).toBe(false)

		// 存在確認すらしない（消す判断より前で降りる）。
		expect(fsMock.existsSync, `${label}: existsSync`).not.toHaveBeenCalled()
		expect(fsMock.unlinkSync, `${label}: unlinkSync`).not.toHaveBeenCalled()
		expect(fsMock.rmdirSync, `${label}: rmdirSync`).not.toHaveBeenCalled()
		expect(deletedPaths()).toEqual([])
		expectAllDeletionsInsideTmp(label)
		// 同じ値を無限に握り続けないよう、map からは落とす（＝再試行もしない）。
		expect(ShellIntegrationManager.terminalTmpDirs.has(12)).toBe(false)
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(`refusing to clean up a path outside the temp directory: ${outside}`),
		)
	})

	it("**【不変条件】clear() でも tmpdir 外のパスは消さない（内側のものだけ消す）**", () => {
		const inside = path.join(os.tmpdir(), "roo-zdotdir-mine")
		const outside = os.homedir()
		ShellIntegrationManager.terminalTmpDirs.set(1, inside)
		ShellIntegrationManager.terminalTmpDirs.set(2, outside)

		ShellIntegrationManager.clear()

		expect(deletedPaths()).toEqual([path.join(inside, ".zshrc"), inside])
		expectAllDeletionsInsideTmp("clear() に外部パスが混在")
		expect(ShellIntegrationManager.terminalTmpDirs.size).toBe(0)
	})
})

// --- 3. clear() ---------------------------------------------------------------

describe("ShellIntegrationManager.clear", () => {
	it("登録が無ければ何もしない", () => {
		ShellIntegrationManager.clear()

		expect(deletedPaths()).toEqual([])
		expect(ShellIntegrationManager.terminalTmpDirs.size).toBe(0)
	})

	it("片付けに失敗したものも含めて map は空になる", () => {
		const good = path.join(os.tmpdir(), "roo-zdotdir-good")
		const bad = path.join(os.tmpdir(), "roo-zdotdir-bad")
		ShellIntegrationManager.terminalTmpDirs.set(1, good)
		ShellIntegrationManager.terminalTmpDirs.set(2, bad)
		fsMock.rmdirSync.mockImplementation((p: unknown) => {
			if (p === bad) {
				throw new Error("EBUSY")
			}
			return undefined
		})

		ShellIntegrationManager.clear()

		// zshCleanupTmpDir は失敗時に map から消さないが、clear() が最後に一掃する。
		expect(ShellIntegrationManager.terminalTmpDirs.size).toBe(0)
		expectAllDeletionsInsideTmp("clear() 失敗混在")
	})
})

// --- 4. シェル統合スクリプトのパス解決 ----------------------------------------

describe("ShellIntegrationManager.getShellIntegrationPath", () => {
	// private static だが、zsh 以外の分岐は外から呼ばないと到達しないので直接叩く。
	const resolvePath = (shell: string): string =>
		(
			ShellIntegrationManager as unknown as {
				getShellIntegrationPath(shell: string): string
			}
		).getShellIntegrationPath(shell)

	const scriptsDir = path.join(
		"/vscode/app-root",
		"out",
		"vs",
		"workbench",
		"contrib",
		"terminal",
		"common",
		"scripts",
	)

	it.each([
		["bash", "shellIntegration-bash.sh"],
		["pwsh", "shellIntegration.ps1"],
		["zsh", "shellIntegration-rc.zsh"],
		["fish", "shellIntegration.fish"],
	])("%s は %s を指す", (shell, filename) => {
		expect(resolvePath(shell)).toBe(path.join(scriptsDir, filename))
	})

	it("未知のシェルは例外にする（既定値で誤ったスクリプトを読ませない）", () => {
		expect(() => resolvePath("nushell")).toThrow("Invalid shell type: nushell")
	})
})
