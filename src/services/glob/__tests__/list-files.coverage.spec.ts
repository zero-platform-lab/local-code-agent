import * as os from "os"
import * as fs from "fs"
import * as childProcess from "child_process"
import { listFiles } from "../list-files"

// list-files.ts の未到達エッジ（特別ディレクトリ・ripgrep 不在・.gitignore 読取失敗・
// 隠しディレクトリ明示指定・execRipgrep の stderr/異常終了/error/timeout など）を、
// 本物の ripgrep プロセスや実 FS を起動せずに検証する。
// arePathsEqual は本物を使う（root/home 判定を実挙動で確かめるため）。

vi.mock("../../ripgrep", () => ({
	getBinPath: vi.fn().mockResolvedValue("/mock/path/to/rg"),
}))

vi.mock("vscode", () => ({
	env: { appRoot: "/mock/app/root" },
}))

vi.mock("fs", () => ({
	promises: {
		access: vi.fn().mockRejectedValue(new Error("Not found")),
		readFile: vi.fn().mockResolvedValue(""),
		readdir: vi.fn().mockResolvedValue([]),
	},
}))

vi.mock("child_process", () => ({
	spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(childProcess.spawn)
const mockReaddir = vi.mocked(fs.promises.readdir)
const mockAccess = vi.mocked(fs.promises.access)
const mockReadFile = vi.mocked(fs.promises.readFile)

/**
 * 設定可能な ripgrep 子プロセスのモックを作る。
 * - dataChunks: stdout に流す行（close 前に順次 emit）
 * - stderrChunks: stderr に流すデータ
 * - closeCode: close イベントの終了コード（null で close を発火しない）
 * - errorObj: error イベントで渡すエラー（あれば error を発火）
 */
function makeProc(opts: {
	dataChunks?: string[]
	stderrChunks?: string[]
	closeCode?: number | null
	errorObj?: Error
}) {
	const { dataChunks = [], stderrChunks = [], closeCode = 0, errorObj } = opts
	const proc: any = {
		stdout: {
			on: vi.fn((event: string, cb: (d: string) => void) => {
				if (event === "data") {
					for (const chunk of dataChunks) setTimeout(() => cb(chunk), 1)
				}
			}),
		},
		stderr: {
			on: vi.fn((event: string, cb: (d: string) => void) => {
				if (event === "data") {
					for (const chunk of stderrChunks) setTimeout(() => cb(chunk), 1)
				}
			}),
		},
		on: vi.fn((event: string, cb: (arg?: any) => void) => {
			if (event === "close" && closeCode !== null) {
				setTimeout(() => cb(closeCode), 5)
			}
			if (event === "error" && errorObj) {
				setTimeout(() => cb(errorObj), 1)
			}
		}),
		kill: vi.fn(),
	}
	return proc
}

const dirent = (name: string, isDir = true) =>
	({ name, isDirectory: () => isDir, isSymbolicLink: () => false, isFile: () => !isDir }) as any

describe("listFiles: 特別ディレクトリの早期 return", () => {
	beforeEach(() => vi.clearAllMocks())

	it("ルートディレクトリはルート1件だけ返す（42-44, 169-171 行）", async () => {
		const [result, limitReached] = await listFiles("/", true, 100)
		const root = "/"
		expect(result).toEqual([root])
		expect(limitReached).toBe(false)
		// 特別扱いなので ripgrep は起動しない
		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it("win32 ではルートを path.parse(...).root で判定する（167 行の win32 分岐）", async () => {
		const original = process.platform
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		try {
			const [result] = await listFiles("/", true, 100)
			expect(result).toEqual(["/"])
			expect(mockSpawn).not.toHaveBeenCalled()
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true })
		}
	})

	it("ホームディレクトリはホーム1件だけ返す（176-178 行）", async () => {
		const home = os.homedir()
		const [result, limitReached] = await listFiles(home, true, 100)
		expect(result).toEqual([home])
		expect(limitReached).toBe(false)
		expect(mockSpawn).not.toHaveBeenCalled()
	})
})

describe("listFiles: ripgrep バイナリ不在", () => {
	beforeEach(() => vi.clearAllMocks())

	it("getBinPath が空なら例外にせず fs 走査にフォールバックする", async () => {
		// 以前は throw していたが、rg 未同梱の環境でも動くよう fs 走査に切り替えた。
		// fs モックは空を返すので結果は空だが、例外にはならない。
		const { getBinPath } = await import("../../ripgrep")
		vi.mocked(getBinPath).mockResolvedValueOnce("" as any)
		const result = await listFiles("/test/dir", false, 100)
		expect(result).toEqual([[], false])
	})
})

describe("listFiles: .gitignore 読み取り失敗", () => {
	beforeEach(() => vi.clearAllMocks())

	it("access は成功するが readFile が失敗しても握りつぶす（342-345 行）", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		// .gitignore は存在するが読めない
		mockAccess.mockResolvedValue(undefined as any)
		mockReadFile.mockRejectedValue(new Error("EACCES"))
		mockReaddir.mockResolvedValue([])
		mockSpawn.mockReturnValue(makeProc({ dataChunks: [], closeCode: 0 }))

		const [result] = await listFiles("/test/dir", false, 100)
		expect(Array.isArray(result)).toBe(true)
	})
})

describe("listFiles: 隠しディレクトリを明示指定した scan", () => {
	beforeEach(() => vi.clearAllMocks())

	it("明示ターゲット配下の critical ディレクトリ(node_modules)は除外し、通常サブは含める（541-545,552-554,580-582 行）", async () => {
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReadFile.mockResolvedValue("")
		// .agent（隠しターゲット）配下: node_modules(critical) と docs(通常) と .cache(隠しサブ)
		mockReaddir.mockImplementation(async (dir: any) => {
			if (String(dir).endsWith(".agent")) {
				return [dirent("node_modules"), dirent("docs"), dirent(".cache")]
			}
			return []
		})
		mockSpawn.mockReturnValue(makeProc({ dataChunks: [], closeCode: 0 }))

		const [result] = await listFiles("/test/.agent", true, 100)
		const dirs = result.filter((r) => r.endsWith("/"))
		// 明示ターゲット配下でも node_modules(critical) は除外される
		expect(dirs.some((d) => d.includes("node_modules"))).toBe(false)
		// 通常サブディレクトリは含まれる
		expect(dirs.some((d) => d.endsWith("docs/"))).toBe(true)
	})
})

describe("listFiles: ディレクトリとファイルの並び", () => {
	beforeEach(() => vi.clearAllMocks())

	it("ディレクトリはファイルより先にソートされる（637-638 行の両分岐）", async () => {
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReadFile.mockResolvedValue("")
		// 複数ディレクトリを返し、比較関数が (dir, file)/(file, dir) 双方の順で呼ばれるようにする
		mockReaddir.mockImplementation(async (dir: any) => {
			if (String(dir).endsWith("/test/proj")) {
				return [dirent("b_dir"), dirent("d_dir"), dirent("m_dir")]
			}
			return []
		})
		// ripgrep が複数ファイルを返す
		mockSpawn.mockReturnValue(makeProc({ dataChunks: ["a.txt\nc.txt\nz.txt\n"], closeCode: 0 }))

		const [result] = await listFiles("/test/proj", true, 100)
		const dirs = result.filter((r) => r.endsWith("/"))
		const files = result.filter((r) => !r.endsWith("/"))
		expect(dirs.length).toBeGreaterThan(0)
		expect(files.length).toBeGreaterThan(0)
		// 全ディレクトリが全ファイルより前に来る
		const lastDirIdx = result.map((r) => r.endsWith("/")).lastIndexOf(true)
		const firstFileIdx = result.findIndex((r) => !r.endsWith("/"))
		expect(lastDirIdx).toBeLessThan(firstFileIdx)
	})

	it("逆順の複数ディレクトリは名前順に並べ替えられる（637 の条件偽側 = dir/dir 比較）", async () => {
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReadFile.mockResolvedValue("")
		// 逆アルファベット順で返すことで comparator(dir, dir) を確実に発火させ、
		// aIsDir && !bIsDir が偽になる経路（638/639 へフォールスルー）を通す。
		mockReaddir.mockImplementation(async (dir: any) => {
			if (String(dir).endsWith("/test/proj2")) {
				return [dirent("z_dir"), dirent("a_dir")]
			}
			return []
		})
		mockSpawn.mockReturnValue(makeProc({ dataChunks: [], closeCode: 0 }))

		const [result] = await listFiles("/test/proj2", true, 100)
		const dirs = result.filter((r) => r.endsWith("/"))
		// a_dir が z_dir より前
		const aIdx = dirs.findIndex((d) => d.endsWith("a_dir/"))
		const zIdx = dirs.findIndex((d) => d.endsWith("z_dir/"))
		expect(aIdx).toBeGreaterThanOrEqual(0)
		expect(aIdx).toBeLessThan(zIdx)
	})
})

describe("listFiles: 通常 scan での隠しサブディレクトリ（再帰判定の複合条件）", () => {
	beforeEach(() => vi.clearAllMocks())

	it("DIRS_TO_IGNORE に無い隠しディレクトリは再帰しないが除外扱いになる（472-475 行）", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReadFile.mockResolvedValue("")
		// 通常ターゲット(/test)配下に、DIRS_TO_IGNORE に無い隠しディレクトリ .hidden と通常の src。
		// .hidden は明示的 ignore ではないので shouldRecurseIntoDir=true となり、
		// shouldRecurse の複合条件（isHidden && includes(.*) && !isTargetDir && !insideHidden）が評価される。
		mockReaddir.mockImplementation(async (dir: any) => {
			if (String(dir).endsWith("/test")) {
				return [dirent(".hidden"), dirent("src")]
			}
			return []
		})
		mockSpawn.mockReturnValue(makeProc({ dataChunks: [], closeCode: 0 }))

		const [result] = await listFiles("/test", true, 100)
		const dirs = result.filter((r) => r.endsWith("/"))
		// DIRS_TO_IGNORE に無い隠しディレクトリはトップレベルには含まれる（除外は明示 ignore のみ）が、
		// shouldRecurse の複合条件により中身へは再帰しない。
		expect(dirs.some((d) => d.endsWith(".hidden/"))).toBe(true)
		expect(dirs.some((d) => d.endsWith("src/"))).toBe(true)
		// .hidden の中身（子ディレクトリ）は走査されない
		const readddirCalledPaths = mockReaddir.mock.calls.map((c) => String(c[0]))
		expect(readddirCalledPaths.some((p) => p.endsWith("/test/.hidden"))).toBe(false)
	})
})

describe("listFiles: getFirstLevelDirectories の catch", () => {
	beforeEach(() => vi.clearAllMocks())

	it("limit 到達後の第一階層走査で readdir が失敗しても握りつぶす（103-105 行）", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReadFile.mockResolvedValue("")
		// readdir は常に失敗（scanDirectory と getFirstLevelDirectories の両 catch を通す）
		mockReaddir.mockRejectedValue(new Error("EACCES"))
		// ripgrep が limit を超えるファイルを返して limitReached=true にする
		mockSpawn.mockReturnValue(makeProc({ dataChunks: ["f1\nf2\nf3\n"], closeCode: 0 }))

		const [result, limitReached] = await listFiles("/test/dir", true, 2)
		expect(limitReached).toBe(true)
		expect(result.length).toBeLessThanOrEqual(2)
	})
})

describe("execRipgrep のイベント処理", () => {
	beforeEach(() => vi.clearAllMocks())

	it("stderr のデータは console.error に流す（676 行）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReaddir.mockResolvedValue([])
		mockSpawn.mockReturnValue(makeProc({ dataChunks: ["x\n"], stderrChunks: ["some warning"], closeCode: 0 }))

		await listFiles("/test/dir", false, 100)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("ripgrep stderr"))
	})

	it("非ゼロ終了コードは警告するが失敗にしない（688-690 行）", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReaddir.mockResolvedValue([])
		mockSpawn.mockReturnValue(makeProc({ dataChunks: ["x\n"], closeCode: 2 }))

		const [result] = await listFiles("/test/dir", false, 100)
		expect(Array.isArray(result)).toBe(true)
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exited with code 2"))
	})

	it("プロセスの error イベントで reject する（698-699 行）", async () => {
		mockAccess.mockRejectedValue(new Error("no gitignore"))
		mockReaddir.mockResolvedValue([])
		mockSpawn.mockReturnValue(makeProc({ dataChunks: [], closeCode: null, errorObj: new Error("spawn ENOENT") }))

		await expect(listFiles("/test/dir", false, 100)).rejects.toThrow("ripgrep process error: spawn ENOENT")
	})

	it("10 秒応答が無いと timeout で部分結果を返す（657-659 行）", async () => {
		vi.useFakeTimers()
		try {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			mockAccess.mockRejectedValue(new Error("no gitignore"))
			mockReaddir.mockResolvedValue([])
			// close も data も来ないプロセス（応答なし）
			const proc = makeProc({ dataChunks: [], closeCode: null })
			mockSpawn.mockReturnValue(proc)

			const promise = listFiles("/test/dir", false, 100)
			// execRipgrep 内の 10 秒タイマーを進めて timeout 経路を発火
			await vi.advanceTimersByTimeAsync(10_000)
			const [result] = await promise

			expect(Array.isArray(result)).toBe(true)
			expect(proc.kill).toHaveBeenCalled()
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ripgrep timed out"))
		} finally {
			vi.useRealTimers()
		}
	})
})
