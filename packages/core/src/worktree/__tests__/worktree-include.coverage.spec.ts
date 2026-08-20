// npx vitest run src/worktree/__tests__/worktree-include.coverage.spec.ts
//
// worktree-include.ts の分岐網羅を埋める spec。
// 既存の worktree-include.spec.ts は実 fs / 実 cp を使った正常系。ここでは
// **fs/promises と child_process を完全にモック**し、既存テストでは踏めない
// 例外パス・プラットフォーム分岐・サイズ計算のフォールバックを決定的に叩く。
//
// 不変条件:
//   - 個々のコピー失敗は握って握りつぶし、他項目のコピーを止めない（作業ツリーを壊さない）
//   - 本物の git / cp / robocopy は一切起動しない（spawn は fake）

import { spawn } from "child_process"
import * as fs from "fs/promises"

import { WorktreeIncludeService } from "../worktree-include.js"

vi.mock("fs/promises")
vi.mock("child_process", () => ({
	execFile: vi.fn(),
	spawn: vi.fn(),
}))

// --- Stats / Dirent の最小フェイク（SUT が読むメンバのみ） ---------------------
type Kind = "file" | "dir" | "other"

function statFor(kind: Kind, size = 0, blksize?: number) {
	return {
		isFile: () => kind === "file",
		isDirectory: () => kind === "dir",
		size,
		blksize,
	}
}

function dirent(name: string, kind: Kind) {
	return {
		name,
		isFile: () => kind === "file",
		isDirectory: () => kind === "dir",
	}
}

// --- 子プロセスの最小フェイク ------------------------------------------------
class FakeChildProcess {
	private handlers: Record<string, (arg?: unknown) => void> = {}
	on(event: string, cb: (arg?: unknown) => void): this {
		this.handlers[event] = cb
		return this
	}
	fire(event: string, arg?: unknown): void {
		this.handlers[event]?.(arg)
	}
}

let lastSpawnCommand: string | undefined
let lastSpawnArgs: readonly string[] | undefined

/** spawn を差し替え、close または error を setImmediate で発火する。 */
function primeSpawn(outcome: { close?: number | null; error?: Error }): void {
	vi.mocked(spawn).mockImplementation(((cmd: string, args: readonly string[]) => {
		lastSpawnCommand = cmd
		lastSpawnArgs = args
		const proc = new FakeChildProcess()
		setImmediate(() => {
			if (outcome.error) {
				proc.fire("error", outcome.error)
			} else {
				proc.fire("close", outcome.close ?? null)
			}
		})
		return proc as unknown as ReturnType<typeof spawn>
	}) as never)
}

const mkImpl = <T>(fn: T): never => fn as never

let service: WorktreeIncludeService
const originalPlatform = process.platform

beforeEach(() => {
	vi.clearAllMocks()
	service = new WorktreeIncludeService()
	lastSpawnCommand = undefined
	lastSpawnArgs = undefined

	// 既定値: すべて成功・空ディレクトリ扱い
	vi.mocked(fs.mkdir).mockResolvedValue(undefined as never)
	vi.mocked(fs.access).mockResolvedValue(undefined as never)
	vi.mocked(fs.copyFile).mockResolvedValue(undefined as never)
	vi.mocked(fs.readdir).mockResolvedValue([] as never)
	vi.mocked(fs.readFile).mockResolvedValue("" as never)
	vi.mocked(fs.stat).mockResolvedValue(statFor("dir") as never)
})

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
})

// ---------------------------------------------------------------------------
// getSizeOnDisk（純粋関数・ブロックサイズのフォールバック）
// ---------------------------------------------------------------------------
describe("getSizeOnDisk", () => {
	it("blksize があればブロック境界に切り上げる", () => {
		expect(service["getSizeOnDisk"]({ size: 100, blksize: 512 })).toBe(512)
		expect(service["getSizeOnDisk"]({ size: 1000, blksize: 512 })).toBe(1024)
	})

	it("blksize が未定義なら論理サイズにフォールバックする", () => {
		expect(service["getSizeOnDisk"]({ size: 100 })).toBe(100)
	})

	it("blksize が 0 のときもフォールバックする", () => {
		expect(service["getSizeOnDisk"]({ size: 100, blksize: 0 })).toBe(100)
	})
})

// ---------------------------------------------------------------------------
// getPathSize（ファイル / ディレクトリ / それ以外 / 例外）
// ---------------------------------------------------------------------------
describe("getPathSize", () => {
	it("ファイルは getSizeOnDisk のサイズを返す", async () => {
		vi.mocked(fs.stat).mockResolvedValue(statFor("file", 100, 512) as never)
		await expect(service["getPathSize"]("/x/file")).resolves.toBe(512)
	})

	it("ディレクトリは再帰サイズ（空なら 0）を返す", async () => {
		vi.mocked(fs.stat).mockResolvedValue(statFor("dir") as never)
		vi.mocked(fs.readdir).mockResolvedValue([] as never)
		await expect(service["getPathSize"]("/x/dir")).resolves.toBe(0)
	})

	it("ファイルでもディレクトリでもなければ 0 を返す", async () => {
		vi.mocked(fs.stat).mockResolvedValue(statFor("other") as never)
		await expect(service["getPathSize"]("/x/socket")).resolves.toBe(0)
	})

	it("stat が失敗したら 0 を返す", async () => {
		vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"))
		await expect(service["getPathSize"]("/x/missing")).resolves.toBe(0)
	})
})

// ---------------------------------------------------------------------------
// getDirectorySizeRecursive（ファイル/ディレクトリ/その他の混在・例外）
// ---------------------------------------------------------------------------
describe("getDirectorySizeRecursive", () => {
	it("ファイル・サブディレクトリ・その他を再帰集計する", async () => {
		vi.mocked(fs.readdir).mockImplementation(
			mkImpl(async (p: string) => {
				if (String(p) === "/top") {
					return [dirent("f", "file"), dirent("d", "dir"), dirent("o", "other")]
				}
				return [] // サブディレクトリ /top/d は空
			}),
		)
		vi.mocked(fs.stat).mockImplementation(mkImpl(async () => statFor("file", 50, 512)))

		await expect(service["getDirectorySizeRecursive"]("/top")).resolves.toBe(512)
	})

	it("エントリの stat が失敗しても他を止めず 0 に丸める", async () => {
		vi.mocked(fs.readdir).mockResolvedValue([dirent("bad", "file")] as never)
		vi.mocked(fs.stat).mockRejectedValue(new Error("EACCES"))

		await expect(service["getDirectorySizeRecursive"]("/top")).resolves.toBe(0)
	})

	it("readdir 自体が失敗したら 0 を返す", async () => {
		vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOTDIR"))

		await expect(service["getDirectorySizeRecursive"]("/nope")).resolves.toBe(0)
	})
})

// ---------------------------------------------------------------------------
// getCurrentDirectorySize（存在すれば再帰サイズ・無ければ 0）
// ---------------------------------------------------------------------------
describe("getCurrentDirectorySize", () => {
	it("ディレクトリが存在すれば再帰サイズを返す", async () => {
		vi.mocked(fs.access).mockResolvedValue(undefined as never)
		vi.mocked(fs.readdir).mockResolvedValue([] as never)
		await expect(service["getCurrentDirectorySize"]("/exists")).resolves.toBe(0)
	})

	it("ディレクトリが無ければ 0 を返す", async () => {
		vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"))
		await expect(service["getCurrentDirectorySize"]("/missing")).resolves.toBe(0)
	})
})

// ---------------------------------------------------------------------------
// parseIgnoreFile（コメント/空行の除去・読み込み失敗）
// ---------------------------------------------------------------------------
describe("parseIgnoreFile", () => {
	it("コメントと空行を除いて trim したパターンを返す", async () => {
		vi.mocked(fs.readFile).mockResolvedValue("node_modules\n# comment\n\n  dist  \n" as never)
		await expect(service["parseIgnoreFile"]("/x/.gitignore")).resolves.toEqual(["node_modules", "dist"])
	})

	it("読み込みに失敗したら空配列を返す", async () => {
		vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
		await expect(service["parseIgnoreFile"]("/x/.gitignore")).resolves.toEqual([])
	})
})

// ---------------------------------------------------------------------------
// findMatchingItems（readdir 失敗時は空配列）
// ---------------------------------------------------------------------------
describe("findMatchingItems", () => {
	it("readdir が失敗したら空配列を返す", async () => {
		const ignoreModule = (await import("ignore")).default
		const includeMatcher = ignoreModule().add(["node_modules"])
		const gitignoreMatcher = ignoreModule().add(["node_modules"])
		vi.mocked(fs.readdir).mockRejectedValue(new Error("EACCES"))

		await expect(service["findMatchingItems"]("/src", includeMatcher, gitignoreMatcher)).resolves.toEqual([])
	})
})

// ---------------------------------------------------------------------------
// copyWorktreeIncludeFiles（パターン空 / コピー失敗の握りつぶし）
// ---------------------------------------------------------------------------
describe("copyWorktreeIncludeFiles", () => {
	it("いずれかのパターンが空なら何もコピーせず空配列を返す", async () => {
		// .worktreeinclude はコメントのみ → パターン 0 件 → 早期 return
		vi.mocked(fs.access).mockResolvedValue(undefined as never)
		vi.mocked(fs.readFile).mockImplementation(
			mkImpl(async (p: string) => (String(p).endsWith(".worktreeinclude") ? "# only comment" : "node_modules")),
		)

		const result = await service.copyWorktreeIncludeFiles("/src", "/dst")

		expect(result).toEqual([])
		expect(spawn).not.toHaveBeenCalled()
	})

	it("個別コピーが失敗しても例外を投げず、その項目を結果から外す", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(fs.access).mockResolvedValue(undefined as never)
		vi.mocked(fs.readFile).mockResolvedValue("node_modules" as never)
		vi.mocked(fs.readdir).mockResolvedValue([dirent("node_modules", "dir")] as never)
		// コピー対象の stat が失敗 → catch へ
		vi.mocked(fs.stat).mockRejectedValue(new Error("EACCES"))

		const result = await service.copyWorktreeIncludeFiles("/src", "/dst")

		expect(result).toEqual([])
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to copy node_modules"), expect.anything())
		errorSpy.mockRestore()
	})
})

// ---------------------------------------------------------------------------
// copyDirectoryWithProgress（プラットフォーム分岐・終了コード判定）
// ---------------------------------------------------------------------------
describe("copyDirectoryWithProgress", () => {
	it("非 Windows は cp を使い、code 0 で成功する", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		primeSpawn({ close: 0 })

		const result = await service["copyDirectoryWithProgress"](
			"/src/node_modules",
			"/dst/node_modules",
			"node_modules",
			0,
		)

		expect(lastSpawnCommand).toBe("cp")
		expect(lastSpawnArgs).toEqual(["-r", "--", "/src/node_modules", "/dst/node_modules"])
		expect(result).toBe(0)
	})

	it("非 Windows で cp が非 0 終了なら reject する", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		primeSpawn({ close: 1 })

		await expect(service["copyDirectoryWithProgress"]("/src/nm", "/dst/nm", "nm", 0)).rejects.toThrow(
			"cp failed with code 1",
		)
	})

	it("Windows は robocopy を使い、code < 8 は成功扱い", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		primeSpawn({ close: 1 }) // robocopy は 1 も成功

		const result = await service["copyDirectoryWithProgress"]("C:/src/nm", "C:/dst/nm", "nm", 0)

		expect(lastSpawnCommand).toBe("robocopy")
		expect(result).toBe(0)
	})

	it("Windows で robocopy が code >= 8 なら reject する", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		primeSpawn({ close: 8 })

		await expect(service["copyDirectoryWithProgress"]("C:/src/nm", "C:/dst/nm", "nm", 0)).rejects.toThrow(
			"robocopy failed with code 8",
		)
	})
})
