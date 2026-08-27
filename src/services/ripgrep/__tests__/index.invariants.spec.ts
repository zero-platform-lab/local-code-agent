// npx vitest run services/ripgrep/__tests__/index.invariants.spec.ts
//
// services/ripgrep は **外部プロセス（rg）を spawn する** モジュール。C0 13.1%
// （未実行 139 行）で、引数組み立て・出力パース・失敗経路がまるごと未検証だった。
//
// ここで固定する最重要の不変条件:
//
//   **検索語・glob・探索ディレクトリがそのまま argv に載る以上、
//     どこに載るか（オプションとして解釈されうるか）を全件で押さえる。**
//
// 検索語は `-e <regex>` の値として渡るので `-e...` や `--foo` で始まっても
// オプションにはならない。一方 **探索ディレクトリは argv の末尾に裸で置かれ、
// `--` 区切りが無い**。この差を argv の完全一致で固定しておかないと、
// 「引数を 1 個足した」だけで rg の解釈が変わる。
//
// **本物の rg は絶対に起動しない**：child_process と readline を完全にモックし、
// spawn に渡った引数だけを観測する。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- モック ------------------------------------------------------------------

/** rg の贋実行。spawn 呼び出しごとに 1 個作られる。 */
interface FakeRun {
	bin: string
	args: string[]
	options: unknown
	kill: ReturnType<typeof vi.fn>
}

const rg = vi.hoisted(() => ({
	/** spawn に渡った内容（全件）。 */
	runs: [] as FakeRun[],
	/** rl に流す行。 */
	lines: [] as string[],
	/** stderr に流すチャンク。 */
	stderr: [] as string[],
	/** 立てるとプロセス側の "error" イベントを発火する。 */
	spawnError: null as Error | null,
	spawn: vi.fn(),
	createInterface: vi.fn(),
}))

// **実プロセスを起動しないための最後の砦。**
vi.mock("child_process", () => ({ spawn: rg.spawn, default: { spawn: rg.spawn } }))
vi.mock("readline", () => ({ createInterface: rg.createInterface, default: { createInterface: rg.createInterface } }))

vi.mock("vscode", () => ({ env: { appRoot: "/vscode/app-root" } }))

const fileExistsAtPath = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))

vi.mock("../../../utils/fs", () => ({ fileExistsAtPath }))

import { regexSearchFiles, getBinPath, truncateLine } from "../index"

// --- 贋 rg の配線 --------------------------------------------------------------

/**
 * spawn → readline の贋物を組む。
 *
 * 実装は `spawn()` 直後に `readline.createInterface({ input: proc.stdout })` を
 * 呼び、"line" / "close" / stderr "data" / proc "error" を購読する。購読が済んだ
 * 次のマクロタスクで、テストが仕込んだ出力を流し込む。
 */
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

			// 購読が終わったあとに出力を流す。
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

/** spawn に渡った argv（1 回目）。 */
const argvOf = (index = 0): string[] => rg.runs[index].args

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	rg.runs = []
	rg.lines = []
	rg.stderr = []
	rg.spawnError = null
	fileExistsAtPath.mockImplementation(async () => true)
	wireFakeRipgrep()
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	errorSpy.mockRestore()
})

// --- rg 出力を組み立てるヘルパ ------------------------------------------------

const begin = (file: string) => JSON.stringify({ type: "begin", data: { path: { text: file } } })
const end = () => JSON.stringify({ type: "end", data: {} })
const match = (lineNumber: number, text: string, offset = 0) =>
	JSON.stringify({
		type: "match",
		data: { line_number: lineNumber, lines: { text }, absolute_offset: offset },
	})
const context = (lineNumber: number, text: string) =>
	JSON.stringify({ type: "context", data: { line_number: lineNumber, lines: { text } } })

// --- 1. バイナリの探索 ---------------------------------------------------------

describe("getBinPath", () => {
	const platformDir = `${process.platform}-${process.arch}`
	const candidates = [
		`node_modules/@vscode/ripgrep-universal/bin/${platformDir}/`,
		`node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${platformDir}/`,
		"node_modules/@vscode/ripgrep/bin/",
		"node_modules/vscode-ripgrep/bin",
		"node_modules.asar.unpacked/vscode-ripgrep/bin/",
		"node_modules.asar.unpacked/@vscode/ripgrep/bin/",
	]

	it.each(candidates.map((folder, index) => [index, folder] as const))(
		"%i 番目の候補にあれば、それより後ろは探さない",
		async (index, folder) => {
			const expected = path.join("/app", folder, "rg")
			fileExistsAtPath.mockImplementation(async (p: unknown) => p === expected)

			expect(await getBinPath("/app")).toBe(expected)
			// 短絡評価なので、見つかった時点で探索は止まる。
			expect(fileExistsAtPath).toHaveBeenCalledTimes(index + 1)
		},
	)

	it("同梱にも PATH にも無ければ undefined を返す", async () => {
		fileExistsAtPath.mockImplementation(async () => false)
		const originalPath = process.env.PATH
		process.env.PATH = ""

		try {
			expect(await getBinPath("/app")).toBeUndefined()
			// PATH が空なので、走査したのは同梱候補だけ。
			expect(fileExistsAtPath).toHaveBeenCalledTimes(candidates.length)
		} finally {
			process.env.PATH = originalPath
		}
	})

	it("同梱版が無ければ PATH 上の rg に fallback する", async () => {
		// 同梱 ripgrep を持たない配布（snap / 一部ディストリのビルド）の救済経路。
		const onPath = path.join("/opt/tools", "rg")
		fileExistsAtPath.mockImplementation(async (p: unknown) => p === onPath)
		const originalPath = process.env.PATH
		process.env.PATH = ["/nowhere", "/opt/tools"].join(path.delimiter)

		try {
			expect(await getBinPath("/app")).toBe(onPath)
		} finally {
			process.env.PATH = originalPath
		}
	})

	it("PATH 上の候補は PATH の並び順で先勝ちする", async () => {
		fileExistsAtPath.mockImplementation(async (p: unknown) => typeof p === "string" && p.startsWith("/opt/"))
		const originalPath = process.env.PATH
		process.env.PATH = ["/opt/first", "/opt/second"].join(path.delimiter)

		try {
			expect(await getBinPath("/app")).toBe(path.join("/opt/first", "rg"))
		} finally {
			process.env.PATH = originalPath
		}
	})

	it("Windows では rg.exe を探す", async () => {
		// binName はモジュール読み込み時に process.platform から決まるので、
		// platform を差し替えてモジュールごと評価し直す。
		const original = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		vi.resetModules()

		try {
			const mod = await import("../index")
			fileExistsAtPath.mockImplementation(async () => true)

			expect(await mod.getBinPath("/app")).toBe(
				path.join("/app", `node_modules/@vscode/ripgrep-universal/bin/win32-${process.arch}/`, "rg.exe"),
			)
		} finally {
			Object.defineProperty(process, "platform", original)
			vi.resetModules()
		}
	})
})

// --- 2. argv の不変条件（最重要） ---------------------------------------------

describe("regexSearchFiles - spawn に渡る argv", () => {
	it("**glob 無しの既定 argv を全件で固定する**", async () => {
		rg.lines = []

		await regexSearchFiles("/repo", "/repo/src", "TODO")

		expect(rg.runs).toHaveLength(1)
		expect(argvOf()).toEqual(["--json", "-e", "TODO", "--context", "1", "--no-messages", "/repo/src"])
		// 実行ファイルは getBinPath が返したパスそのもの。
		expect(rg.runs[0].bin).toBe(
			path.join(
				"/vscode/app-root",
				`node_modules/@vscode/ripgrep-universal/bin/${process.platform}-${process.arch}/`,
				"rg",
			),
		)
		// **シェルを介さない**：spawn の第 3 引数を渡していない＝ shell:false。
		expect(rg.runs[0].options).toBeUndefined()
	})

	it("**glob 付きの argv を全件で固定する（--glob は --context より前）**", async () => {
		await regexSearchFiles("/repo", "/repo/src", "TODO", "*.ts")

		expect(argvOf()).toEqual([
			"--json",
			"-e",
			"TODO",
			"--glob",
			"*.ts",
			"--context",
			"1",
			"--no-messages",
			"/repo/src",
		])
	})

	it("**`-e` で始まる検索語もオプションにならない（-e の値として 1 個の argv に載る）**", async () => {
		// argv 配列を直接 spawn しており、シェル経由でも文字列連結でもないので、
		// 検索語は必ず `-e` の直後の 1 要素になる。
		await regexSearchFiles("/repo", "/repo/src", "-e --no-ignore")

		expect(argvOf()).toEqual(["--json", "-e", "-e --no-ignore", "--context", "1", "--no-messages", "/repo/src"])
		expect(argvOf().filter((a) => a === "-e")).toHaveLength(1)
	})

	it.each([
		["--files", "--files"],
		["空文字", ""],
		["スペースとクォート", `foo bar" ; rm -rf /`],
		["改行入り", "line1\nline2"],
		["ヌル文字を含まない制御文字", "tab\there"],
	])("検索語（%s）は -e の値としてそのまま 1 要素で渡る", async (_label, regex) => {
		await regexSearchFiles("/repo", "/repo/src", regex)

		expect(argvOf()[1]).toBe("-e")
		expect(argvOf()[2]).toBe(regex)
		expect(argvOf()).toHaveLength(7)
	})

	it("**glob も --glob の値として 1 要素で渡る（`-` 始まりでも分割されない）**", async () => {
		await regexSearchFiles("/repo", "/repo/src", "TODO", "--no-ignore")

		expect(argvOf()).toEqual([
			"--json",
			"-e",
			"TODO",
			"--glob",
			"--no-ignore",
			"--context",
			"1",
			"--no-messages",
			"/repo/src",
		])
	})

	it("空文字の glob は「未指定」として扱われ、--glob ごと落ちる", async () => {
		await regexSearchFiles("/repo", "/repo/src", "TODO", "")

		expect(argvOf()).not.toContain("--glob")
	})

	it("【現状の挙動】探索ディレクトリは末尾に裸で置かれる（`--` 区切りが無い）", async () => {
		// argv の最後の要素がそのまま rg のパス引数になる。`--` を挟んでいないので、
		// `-` で始まるディレクトリ名は rg 側でオプションとして解釈されうる。
		// 現状これを防ぐガードは実装に無いため、characterization test として固定する。
		await regexSearchFiles("/repo", "-rf", "TODO")

		const argv = argvOf()
		expect(argv).not.toContain("--")
		expect(argv[argv.length - 1]).toBe("-rf")
		expect(argv.indexOf("-rf")).toBe(argv.length - 1)
	})

	it("rg が見つからなければ spawn せずに例外にする", async () => {
		fileExistsAtPath.mockImplementation(async () => false)

		await expect(regexSearchFiles("/repo", "/repo/src", "TODO")).rejects.toThrow("Could not find ripgrep binary")

		expect(rg.spawn).not.toHaveBeenCalled()
	})
})

// --- 3. 出力のパース -----------------------------------------------------------

describe("regexSearchFiles - 出力のパース", () => {
	it("match と context を 1 ブロックにまとめて整形する", async () => {
		rg.lines = [
			begin("/repo/src/a.ts"),
			context(1, "before\n"),
			match(2, "// TODO: fix\n", 12),
			context(3, "after\n"),
			end(),
		]

		const result = await regexSearchFiles("/repo", "/repo/src", "TODO")

		expect(result).toContain("Found 1 result.")
		expect(result).toContain(`# ${path.join("src", "a.ts").toPosix()}`)
		expect(result).toContain("  1 | before")
		expect(result).toContain("  2 | // TODO: fix")
		expect(result).toContain("  3 | after")
		expect(result.trimEnd().endsWith("----")).toBe(true)
	})

	it("行が飛んでいれば別ブロックに割る", async () => {
		rg.lines = [begin("/repo/src/a.ts"), match(1, "one\n"), match(50, "fifty\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("Found 2 results.")
		// ブロック区切りが 2 回出る。
		expect(result.split("----").length - 1).toBe(2)
	})

	it("複数ファイルはファイルごとに見出しを付ける", async () => {
		rg.lines = [begin("/repo/src/a.ts"), match(1, "a\n"), end(), begin("/repo/src/b.ts"), match(1, "b\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain(`# ${path.join("src", "a.ts").toPosix()}`)
		expect(result).toContain(`# ${path.join("src", "b.ts").toPosix()}`)
	})

	it("同じファイルが 2 ブロックに分かれて出てきたら、最初のブロックだけ採用する", async () => {
		// rg が同一ファイルを 2 度 begin/end することは（--context の切れ目などで）ある。
		// 実装はファイル名でグルーピングし、2 度目は既存キーがあるので取り込まない。
		rg.lines = [
			begin("/repo/src/a.ts"),
			match(1, "first\n"),
			end(),
			begin("/repo/src/a.ts"),
			match(90, "second\n"),
			end(),
		]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("Found 2 results.")
		expect(result).toContain("first")
		expect(result).not.toContain("second")
		// 見出しは 1 度だけ。
		expect(result.split(`# ${path.join("src", "a.ts").toPosix()}`).length - 1).toBe(1)
	})

	it("500 文字を超える行は truncateLine で切り詰める", async () => {
		const long = "x".repeat(600)
		rg.lines = [begin("/repo/src/a.ts"), match(1, long), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain(truncateLine(long))
		expect(result).toContain("[truncated...]")
	})

	it("begin より前の match は捨てる（currentFile が無い）", async () => {
		rg.lines = [match(1, "orphan\n"), begin("/repo/src/a.ts"), match(2, "kept\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("kept")
		expect(result).not.toContain("orphan")
		expect(result).toContain("Found 1 result.")
	})

	it("未知の type は黙って読み飛ばす", async () => {
		rg.lines = [
			JSON.stringify({ type: "summary", data: { elapsed: 1 } }),
			begin("/repo/src/a.ts"),
			match(1, "hit\n"),
			end(),
		]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("Found 1 result.")
	})

	it("JSON として壊れた行はログを出して読み飛ばす", async () => {
		rg.lines = ["{ not json", begin("/repo/src/a.ts"), match(1, "hit\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(errorSpy).toHaveBeenCalledWith("Error parsing ripgrep output:", expect.any(Error))
		expect(result).toContain("Found 1 result.")
	})

	it("空行は読み飛ばす", async () => {
		rg.lines = ["", begin("/repo/src/a.ts"), match(1, "hit\n"), "", end(), ""]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("Found 1 result.")
	})

	it("ヒットが無ければ 0 件として返す", async () => {
		rg.lines = []

		const result = await regexSearchFiles("/repo", "/repo/src", "nope")

		expect(result).toBe("Found 0 results.")
	})

	it("300 件以上なら打ち切りを明示する", async () => {
		const lines: string[] = []
		for (let i = 0; i < 300; i++) {
			lines.push(begin(`/repo/src/f${i}.ts`), match(1, `hit ${i}\n`), end())
		}
		rg.lines = lines

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toContain("Showing first 300 of 300+ results. Use a more specific search if necessary.")
	})
})

// --- 4. .agentignore との連携 --------------------------------------------------

describe("regexSearchFiles - .agentignore", () => {
	it("コントローラが拒否したファイルは結果に出さない", async () => {
		rg.lines = [
			begin("/repo/src/allowed.ts"),
			match(1, "ok\n"),
			end(),
			begin("/repo/.env"),
			match(1, "SECRET=1\n"),
			end(),
		]
		const validateAccess = vi.fn((file: string) => !file.endsWith(".env"))

		const result = await regexSearchFiles("/repo", "/repo", "x", undefined, {
			validateAccess,
		} as never)

		expect(validateAccess).toHaveBeenCalledTimes(2)
		expect(result).toContain("allowed.ts")
		expect(result).not.toContain("SECRET=1")
		expect(result).toContain("Found 1 result.")
	})

	it("コントローラを渡さなければ素通しする", async () => {
		rg.lines = [begin("/repo/.env"), match(1, "SECRET=1\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo", "x")

		expect(result).toContain("SECRET=1")
	})
})

// --- 5. 失敗と打ち切り ---------------------------------------------------------

describe("regexSearchFiles - 失敗と打ち切り", () => {
	it("stderr に出力があれば結果を捨てて 'No results found' を返す", async () => {
		rg.stderr = ["rg: /repo/src: No such file or directory\n"]
		rg.lines = [begin("/repo/src/a.ts"), match(1, "hit\n"), end()]

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toBe("No results found")
		expect(errorSpy).toHaveBeenCalledWith("Error executing ripgrep:", expect.any(Error))
	})

	it("プロセスの error イベントでも 'No results found' に落とす", async () => {
		rg.spawnError = new Error("spawn ENOENT")

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(result).toBe("No results found")
		expect(errorSpy).toHaveBeenCalledWith("Error executing ripgrep:", expect.any(Error))
	})

	it("**出力が上限（1500 行）を超えたら rl を閉じてプロセスを kill する**", async () => {
		// 上限を超えた分を読み続けると、巨大なリポジトリで拡張ごと固まる。
		const lines: string[] = []
		for (let i = 0; i < 1600; i++) {
			lines.push(begin(`/repo/src/f${i}.ts`), match(1, `hit ${i}\n`), end())
		}
		rg.lines = lines

		const result = await regexSearchFiles("/repo", "/repo/src", "x")

		expect(rg.runs[0].kill).toHaveBeenCalledTimes(1)
		expect(result).toContain("Showing first 300 of 300+ results.")
	})
})
