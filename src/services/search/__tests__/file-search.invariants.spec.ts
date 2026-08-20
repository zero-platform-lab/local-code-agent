// npx vitest run services/search/__tests__/file-search.invariants.spec.ts
//
// services/search/file-search も **外部プロセス（rg）を spawn する** モジュール。
// C0 11.5%（未実行 123 行）で、引数組み立て・出力の畳み込み・失敗経路が未検証だった。
//
// ここで固定する最重要の不変条件:
//
//   **利用者が打ち込む検索クエリは argv に載らない。**
//   ファイル列挙は固定の argv で行い、絞り込みは取得後に fzf でメモリ上で行う。
//   ここが崩れると、クエリがそのまま rg のオプションになりうる。
//
//   **ワークスペースパスは argv の末尾に裸で載る**（`--` 区切りが無い）ので、
//   その位置と前後の引数を全件で固定する。
//
// **本物の rg は絶対に起動しない**：child_process と readline を完全にモックする。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- モック ------------------------------------------------------------------

interface FakeRun {
	bin: string
	args: string[]
	options: unknown
	kill: ReturnType<typeof vi.fn>
}

const rg = vi.hoisted(() => ({
	runs: [] as FakeRun[],
	lines: [] as string[],
	stderr: [] as string[],
	spawnError: null as Error | null,
	spawn: vi.fn(),
	createInterface: vi.fn(),
}))

// **実プロセスを起動しないための最後の砦。**
vi.mock("child_process", () => ({ spawn: rg.spawn, default: { spawn: rg.spawn } }))
vi.mock("readline", () => ({ createInterface: rg.createInterface, default: { createInterface: rg.createInterface } }))

const getBinPath = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "/bin/rg" as string | undefined))

vi.mock("../../ripgrep", () => ({ getBinPath }))

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn((..._a: unknown[]): boolean => false),
	lstatSync: vi.fn((..._a: unknown[]): { isDirectory: () => boolean } => ({ isDirectory: () => false })),
}))

vi.mock("fs", () => ({ ...fsMock, default: fsMock }))

const configMock = vi.hoisted(() => ({
	getConfiguration: vi.fn(),
}))

vi.mock("vscode", () => ({
	env: { appRoot: "/vscode/app-root" },
	workspace: { getConfiguration: configMock.getConfiguration },
}))

vi.mock("../../../shared/package", () => ({
	Package: { name: "openai-agent", publisher: "internal", version: "1.0.0", outputChannel: "OpenAI-Agent" },
}))

import { executeRipgrep, executeRipgrepForFiles, searchWorkspaceFiles, type FileResult } from "../file-search"

// --- 贋 rg の配線 --------------------------------------------------------------

function wireFakeRipgrep(): void {
	rg.spawn.mockImplementation((bin: string, args: string[], options?: unknown) => {
		const stderrHandlers: ((chunk: Buffer) => void)[] = []
		const procHandlers = new Map<string, ((...a: unknown[]) => void)[]>()

		const proc = {
			stdout: { __fake: "stdout" },
			stderr: {
				on: (event: string, cb: (chunk: Buffer) => void) => {
					if (event === "data") {
						stderrHandlers.push(cb)
					}
				},
			},
			on: (event: string, cb: (...a: unknown[]) => void) => {
				const list = procHandlers.get(event) ?? []
				list.push(cb)
				procHandlers.set(event, list)
			},
			kill: vi.fn(),
		}

		rg.runs.push({ bin, args, options, kill: proc.kill })

		rg.createInterface.mockImplementation(() => {
			const rlHandlers = new Map<string, ((...a: unknown[]) => void)[]>()
			let closed = false

			const emit = (event: string, ...payload: unknown[]) => {
				for (const cb of rlHandlers.get(event) ?? []) {
					cb(...payload)
				}
			}

			const rl = {
				on: (event: string, cb: (...a: unknown[]) => void) => {
					const list = rlHandlers.get(event) ?? []
					list.push(cb)
					rlHandlers.set(event, list)
					return rl
				},
				close: () => {
					if (closed) {
						return
					}
					closed = true
					emit("close")
				},
			}

			setTimeout(() => {
				for (const chunk of rg.stderr) {
					for (const cb of stderrHandlers) {
						cb(Buffer.from(chunk))
					}
				}

				for (const line of rg.lines) {
					if (closed) {
						break
					}
					emit("line", line)
				}

				if (rg.spawnError) {
					for (const cb of procHandlers.get("error") ?? []) {
						cb(rg.spawnError)
					}
					return
				}

				rl.close()
			}, 0)

			return rl
		})

		return proc
	})
}

/** search / openai-agent 設定を差し替える。 */
function stubConfig(options: { search?: Record<string, unknown>; maxFiles?: number } = {}): void {
	configMock.getConfiguration.mockImplementation((section: string) => {
		if (section === "search") {
			return { get: (key: string) => options.search?.[key] }
		}
		return {
			get: (_key: string, defaultValue: number) => options.maxFiles ?? defaultValue,
		}
	})
}

const argvOf = (index = 0): string[] => rg.runs[index].args

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	rg.runs = []
	rg.lines = []
	rg.stderr = []
	rg.spawnError = null
	getBinPath.mockImplementation(async () => "/bin/rg")
	fsMock.existsSync.mockImplementation(() => false)
	fsMock.lstatSync.mockImplementation(() => ({ isDirectory: () => false }))
	stubConfig()
	wireFakeRipgrep()
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	errorSpy.mockRestore()
})

// --- 1. argv の不変条件（最重要） ---------------------------------------------

describe("executeRipgrepForFiles - spawn に渡る argv", () => {
	const baseArgs = (workspace: string) => [
		"--files",
		"--follow",
		"--hidden",
		"-g",
		"!**/node_modules/**",
		"-g",
		"!**/.git/**",
		"-g",
		"!**/out/**",
		"-g",
		"!**/dist/**",
		workspace,
	]

	it("**既定の argv を全件で固定する（ワークスペースパスは末尾に裸で載る）**", async () => {
		await executeRipgrepForFiles("/repo")

		expect(rg.runs).toHaveLength(1)
		expect(argvOf()).toEqual(baseArgs("/repo"))
		expect(rg.runs[0].bin).toBe("/bin/rg")
		// **シェルを介さない**：spawn の第 3 引数を渡していない＝ shell:false。
		expect(rg.runs[0].options).toBeUndefined()
		// `--` 区切りは無い。
		expect(argvOf()).not.toContain("--")
	})

	it("【現状の挙動】`-` で始まるワークスペースパスも末尾に裸で載る", async () => {
		// `--` を挟んでいないので rg 側でオプションとして解釈されうる。
		// 現状これを防ぐガードは実装に無いため characterization test として固定する。
		await executeRipgrepForFiles("--files-with-matches")

		const argv = argvOf()
		expect(argv[argv.length - 1]).toBe("--files-with-matches")
		expect(argv).not.toContain("--")
	})

	it.each([
		["useIgnoreFiles", "--no-ignore"],
		["useGlobalIgnoreFiles", "--no-ignore-global"],
		["useParentIgnoreFiles", "--no-ignore-parent"],
	])("VS Code の search.%s=false で %s を足す", async (key, flag) => {
		stubConfig({ search: { [key]: false } })

		await executeRipgrepForFiles("/repo")

		expect(argvOf()).toContain(flag)
		// 追加位置は --hidden の直後、glob 群の前。
		expect(argvOf().indexOf(flag)).toBe(3)
	})

	it("3 つとも false なら 3 つとも並ぶ（順序も固定）", async () => {
		stubConfig({
			search: { useIgnoreFiles: false, useGlobalIgnoreFiles: false, useParentIgnoreFiles: false },
		})

		await executeRipgrepForFiles("/repo")

		expect(argvOf()).toEqual([
			"--files",
			"--follow",
			"--hidden",
			"--no-ignore",
			"--no-ignore-global",
			"--no-ignore-parent",
			"-g",
			"!**/node_modules/**",
			"-g",
			"!**/.git/**",
			"-g",
			"!**/out/**",
			"-g",
			"!**/dist/**",
			"/repo",
		])
	})

	it("設定が true / 未設定なら余計なフラグを足さない", async () => {
		stubConfig({ search: { useIgnoreFiles: true, useGlobalIgnoreFiles: undefined } })

		await executeRipgrepForFiles("/repo")

		expect(argvOf()).toEqual(baseArgs("/repo"))
	})

	it("上限は引数優先、無ければ設定値を使う", async () => {
		stubConfig({ maxFiles: 3 })
		rg.lines = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts", "/repo/e.ts"]

		const withConfig = await executeRipgrepForFiles("/repo")
		expect(withConfig.filter((r) => r.type === "file")).toHaveLength(3)

		rg.runs = []
		const withArgument = await executeRipgrepForFiles("/repo", 1)
		expect(withArgument.filter((r) => r.type === "file")).toHaveLength(1)
		// 設定は引数がある場合も読まれるが、値は引数が勝つ。
		expect(configMock.getConfiguration).toHaveBeenCalledWith("openai-agent")
	})
})

describe("searchWorkspaceFiles - 検索クエリは argv に載らない", () => {
	it("**クエリ文字列が spawn の argv に一切現れない**", async () => {
		// 絞り込みは fzf でメモリ上に行う。クエリが argv に載ると
		// `-g` や `--pre` のようなオプション注入の窓になる。
		rg.lines = ["/repo/src/app.ts", "/repo/src/util.ts"]
		const hostileQuery = "--pre=/bin/sh"

		await searchWorkspaceFiles(hostileQuery, "/repo")

		expect(rg.runs).toHaveLength(1)
		for (const arg of argvOf()) {
			expect(arg).not.toContain(hostileQuery)
		}
		expect(argvOf()).toEqual([
			"--files",
			"--follow",
			"--hidden",
			"-g",
			"!**/node_modules/**",
			"-g",
			"!**/.git/**",
			"-g",
			"!**/out/**",
			"-g",
			"!**/dist/**",
			"/repo",
		])
	})

	it.each(["-e", "--files", "$(id)", "`id`", "; rm -rf /", "\n--no-ignore"])(
		"危険なクエリ %j でも argv は変わらない",
		async (query) => {
			rg.lines = ["/repo/src/app.ts"]

			await searchWorkspaceFiles(query, "/repo")

			expect(argvOf()).toHaveLength(12)
			expect(argvOf()[argvOf().length - 1]).toBe("/repo")
		},
	)
})

// --- 2. executeRipgrep の出力畳み込み ------------------------------------------

describe("executeRipgrep", () => {
	it("rg が見つからなければ spawn せずに例外にする", async () => {
		getBinPath.mockResolvedValue(undefined)

		await expect(executeRipgrep({ args: ["--files"], workspacePath: "/repo" })).rejects.toThrow(
			"ripgrep not found: undefined",
		)

		expect(rg.spawn).not.toHaveBeenCalled()
	})

	it("ファイルと親ディレクトリを両方返す（重複ディレクトリは 1 回だけ）", async () => {
		rg.lines = ["/repo/src/core/a.ts", "/repo/src/core/b.ts", "/repo/top.ts"]

		const results = await executeRipgrep({ args: [], workspacePath: "/repo" })

		expect(results.filter((r) => r.type === "file").map((r) => r.path)).toEqual([
			path.join("src", "core", "a.ts"),
			path.join("src", "core", "b.ts"),
			"top.ts",
		])
		// ルート直下のファイルは dirname が "." なのでディレクトリを生まない。
		expect(results.filter((r) => r.type === "folder").map((r) => r.path)).toEqual([path.join("src", "core"), "src"])
		expect(results.find((r) => r.path === path.join("src", "core"))?.label).toBe("core")
	})

	it("label はベース名になる", async () => {
		rg.lines = ["/repo/src/app.ts"]

		const results = await executeRipgrep({ args: [], workspacePath: "/repo" })

		expect(results[0]).toEqual<FileResult>({
			path: path.join("src", "app.ts"),
			type: "file",
			label: "app.ts",
		})
	})

	it("**上限に達したら rl を閉じてプロセスを kill する**", async () => {
		rg.lines = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]

		const results = await executeRipgrep({ args: [], workspacePath: "/repo", limit: 2 })

		expect(rg.runs[0].kill).toHaveBeenCalledTimes(1)
		expect(results.filter((r) => r.type === "file")).toHaveLength(2)
	})

	it("既定の上限は 500 件", async () => {
		rg.lines = Array.from({ length: 501 }, (_, i) => `/repo/f${i}.ts`)

		const results = await executeRipgrep({ args: [], workspacePath: "/repo" })

		expect(results.filter((r) => r.type === "file")).toHaveLength(500)
		expect(rg.runs[0].kill).toHaveBeenCalledTimes(1)
	})

	it("個々のパス処理でエラーが出ても他の行は落とさない", async () => {
		// workspacePath が文字列でないと path.relative が投げる。壊れた呼び出し側の再現。
		rg.lines = ["/repo/a.ts"]

		const results = await executeRipgrep({ args: [], workspacePath: 123 as never })

		expect(results).toEqual([])
	})

	it("stderr があって結果が 0 件なら reject する", async () => {
		rg.stderr = ["rg: unrecognized flag\n"]
		rg.lines = []

		await expect(executeRipgrep({ args: [], workspacePath: "/repo" })).rejects.toThrow(
			"ripgrep process error: rg: unrecognized flag",
		)
	})

	it("stderr があっても結果が取れていれば返す（警告混じりの出力を捨てない）", async () => {
		rg.stderr = ["rg: /repo/broken-symlink: No such file or directory\n"]
		rg.lines = ["/repo/a.ts"]

		const results = await executeRipgrep({ args: [], workspacePath: "/repo" })

		expect(results.map((r) => r.path)).toEqual(["a.ts"])
	})

	it("プロセスの error イベントは reject に変換する", async () => {
		rg.spawnError = new Error("spawn ENOENT")

		await expect(executeRipgrep({ args: [], workspacePath: "/repo" })).rejects.toThrow(
			"ripgrep process error: spawn ENOENT",
		)
	})
})

// --- 3. searchWorkspaceFiles ---------------------------------------------------

describe("searchWorkspaceFiles", () => {
	it("クエリが空なら先頭から limit 件返す（fzf を通さない）", async () => {
		rg.lines = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]

		const results = await searchWorkspaceFiles("", "/repo", 2)

		expect(results.map((r) => r.path)).toEqual(["a.ts", "b.ts"])
	})

	it("空白だけのクエリも「クエリ無し」として扱う", async () => {
		rg.lines = ["/repo/a.ts", "/repo/b.ts"]

		const results = await searchWorkspaceFiles("   ", "/repo", 1)

		expect(results.map((r) => r.path)).toEqual(["a.ts"])
	})

	it("既定の limit は 20 件", async () => {
		rg.lines = Array.from({ length: 30 }, (_, i) => `/repo/f${i}.ts`)

		const results = await searchWorkspaceFiles("", "/repo")

		expect(results).toHaveLength(20)
	})

	it("fzf でクエリに一致するものだけ返す", async () => {
		rg.lines = ["/repo/src/controller.ts", "/repo/src/view.ts"]

		const results = await searchWorkspaceFiles("controller", "/repo")

		expect(results.map((r) => r.path)).toContain(path.join("src", "controller.ts").toPosix())
		expect(results.map((r) => r.path)).not.toContain(path.join("src", "view.ts").toPosix())
	})

	it("実体がディレクトリなら type を folder に直し、パスは posix 表記にする", async () => {
		rg.lines = ["/repo/src/app.ts"]
		const dirPath = path.join("/repo", "src")
		fsMock.existsSync.mockImplementation((p: unknown) => p === dirPath)
		fsMock.lstatSync.mockImplementation(() => ({ isDirectory: () => true }))

		const results = await searchWorkspaceFiles("src", "/repo")

		const src = results.find((r) => r.path === "src")
		expect(src).toMatchObject({ path: "src", type: "folder" })
	})

	it("実体がファイルなら type を file に直す", async () => {
		rg.lines = ["/repo/src/app.ts"]
		const filePath = path.join("/repo", path.join("src", "app.ts"))
		fsMock.existsSync.mockImplementation((p: unknown) => p === filePath)
		fsMock.lstatSync.mockImplementation(() => ({ isDirectory: () => false }))

		const results = await searchWorkspaceFiles("app", "/repo")

		expect(results.find((r) => r.label === "app.ts")).toMatchObject({ type: "file" })
	})

	it("実体が無いものは rg が返した type のまま残す", async () => {
		rg.lines = ["/repo/src/app.ts"]
		fsMock.existsSync.mockImplementation(() => false)

		const results = await searchWorkspaceFiles("app", "/repo")

		expect(results.find((r) => r.label === "app.ts")).toMatchObject({
			path: path.join("src", "app.ts"),
			type: "file",
		})
		expect(fsMock.lstatSync).not.toHaveBeenCalled()
	})

	it("label が空の項目が混ざっても fzf 用の文字列を組めて落ちない", async () => {
		// rg がワークスペース自身のパスを 1 行返すと相対パスが空文字になり、
		// label も空文字（falsy）になる。fzf のセレクタはこれを空文字に畳む。
		rg.lines = ["/repo", "/repo/app.ts"]
		fsMock.existsSync.mockImplementation(() => false)

		const results = await searchWorkspaceFiles("app", "/repo")

		expect(results.map((r) => r.path)).toContain("app.ts")
	})

	it("rg が失敗しても例外を投げず空配列を返す", async () => {
		getBinPath.mockResolvedValue(undefined)

		const results = await searchWorkspaceFiles("anything", "/repo")

		expect(results).toEqual([])
		expect(errorSpy).toHaveBeenCalledWith("Error in searchWorkspaceFiles:", expect.any(Error))
	})
})
