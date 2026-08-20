// npx vitest run core/mentions/__tests__/index.invariants.spec.ts
//
// core/mentions は「利用者が打った @ / スラッシュコマンドを解決して、モデルに
// 渡すコンテキストへ展開する」入口。C0 27.6%（未実行 247 行）で、ファイル読み・
// フォルダ展開・診断・git・ターミナル取り込みのほとんどが未検証だった。
//
// ここで固定する最重要の不変条件:
//
//   1. **存在しないファイルを mention されたら、その内容を読みに行かない。**
//      fs.stat が失敗した時点で打ち切り、extractTextFromFileWithMetadata にも
//      isBinaryFile にも一切到達しない（＝エラー文言の中に中身が混ざらない）。
//
//   2. **ワークスペースの外へ解決する mention は fs にすら触らない。**
//      `@/../../../.ssh/id_rsa` のような mention は stat も readdir もせずに拒否する。
//      processUserContentMentions は `<user_message>` を含むテキストなら tool_result にも
//      mention 展開をかけるため、リポジトリ内のファイルに mention を仕込んでおくだけで
//      発火する（プロンプトインジェクション経由の任意ファイル読み出し）。
//      「読んでからエラーにする」ではモデルのコンテキストに入った後なので手遅れ。
//
// fs / 子プロセス（git）/ VS Code API はすべてモックし、実ファイルには触れない。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- モック ------------------------------------------------------------------

/** stat / readdir の戻り値は分岐ごとに差し替えるので、型は広めに固定しておく。 */
type FakeStats = { isFile: () => boolean; isDirectory: () => boolean }

const fsMock = vi.hoisted(() => ({
	stat: vi.fn(
		async (..._a: unknown[]): Promise<{ isFile: () => boolean; isDirectory: () => boolean }> => ({
			isFile: () => true,
			isDirectory: () => false,
		}),
	),
	readdir: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
}))

vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }))

const isBinaryFile = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => false))

vi.mock("isbinaryfile", () => ({ isBinaryFile }))

const vscodeMock = vi.hoisted(() => ({
	executeCommand: vi.fn(async (..._a: unknown[]) => undefined),
	openExternal: vi.fn(async (..._a: unknown[]) => true),
	readText: vi.fn(async () => ""),
	writeText: vi.fn(async (..._a: unknown[]) => undefined),
	getDiagnostics: vi.fn(() => [] as unknown[]),
}))

vi.mock("vscode", () => ({
	commands: { executeCommand: vscodeMock.executeCommand },
	env: {
		openExternal: vscodeMock.openExternal,
		clipboard: { readText: vscodeMock.readText, writeText: vscodeMock.writeText },
	},
	languages: { getDiagnostics: vscodeMock.getDiagnostics },
	Uri: {
		file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
		parse: (p: string) => ({ fsPath: p, path: p, scheme: "https" }),
	},
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}))

const gitMock = vi.hoisted(() => ({
	getCommitInfo: vi.fn(async (..._a: unknown[]) => "commit info"),
	getWorkingState: vi.fn(async (..._a: unknown[]) => "working state"),
}))

vi.mock("../../../utils/git", () => gitMock)

const openFile = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile }))

const extractTextFromFileWithMetadata = vi.hoisted(() =>
	vi.fn(
		async (
			..._a: unknown[]
		): Promise<{
			content: string
			totalLines: number
			returnedLines: number
			wasTruncated: boolean
			linesShown?: [number, number]
		}> => ({
			content: "1 | hello",
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
		}),
	),
)

vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFileWithMetadata }))

const diagnosticsToProblemsString = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "problem list"))

vi.mock("../../../integrations/diagnostics", () => ({ diagnosticsToProblemsString }))

const getCommand = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined as unknown))

vi.mock("../../../services/command/commands", () => ({ getCommand }))

import type { Command } from "../../../services/command/commands"
import type { SkillContent } from "../../../shared/skills"
import { openMention, parseMentions, getLatestTerminalOutput } from "../index"

// --- ヘルパ ------------------------------------------------------------------

const CWD = path.resolve(path.sep, "repo")

/** ファイル / ディレクトリ / それ以外の stat を作る。 */
function statAs(kind: "file" | "dir" | "other"): FakeStats {
	return { isFile: () => kind === "file", isDirectory: () => kind === "dir" }
}

/** fs.readdir が返す Dirent 相当。 */
function dirent(name: string, kind: "file" | "dir" | "other" = "file") {
	return { name, isFile: () => kind === "file", isDirectory: () => kind === "dir" }
}

function makeCommand(overrides: Partial<Command> = {}): Command {
	return {
		name: "deploy",
		content: "deploy body",
		source: "project",
		filePath: "/repo/.agent/commands/deploy.md",
		...overrides,
	}
}

function makeSkill(overrides: Partial<SkillContent> = {}): SkillContent {
	return {
		name: "review",
		source: "project",
		description: "review skill",
		instructions: "do the review",
		...overrides,
	} as SkillContent
}

/**
 * **ファイル本文を読みに行っていないこと。**
 * TaskDeletionController.spec の「fs.rm が飛んでいない」に相当する検査で、
 * mention 解決における「触ってはいけない副作用」がこれ。
 */
function expectNoFileRead(label: string): void {
	expect(extractTextFromFileWithMetadata, `${label}: extractText`).not.toHaveBeenCalled()
	expect(isBinaryFile, `${label}: isBinaryFile`).not.toHaveBeenCalled()
	expect(fsMock.readdir, `${label}: readdir`).not.toHaveBeenCalled()
}

/**
 * **fs に一切触れていないこと。**
 * 封じ込めの検査は stat より前で終わる必要がある。stat まで飛ばしてしまうと
 * 「存在するか」「いつ更新されたか」という情報だけは外部へ漏れるうえ、
 * 実装が 1 行ずれれば本文まで読む位置に戻る。
 */
function expectNothingTouched(label: string): void {
	expect(fsMock.stat, `${label}: stat`).not.toHaveBeenCalled()
	expectNoFileRead(label)
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	fsMock.stat.mockImplementation(async () => statAs("file"))
	fsMock.readdir.mockImplementation(async () => [])
	isBinaryFile.mockImplementation(async () => false)
	extractTextFromFileWithMetadata.mockImplementation(async () => ({
		content: "1 | hello",
		totalLines: 1,
		returnedLines: 1,
		wasTruncated: false,
	}))
	diagnosticsToProblemsString.mockImplementation(async () => "problem list")
	getCommand.mockImplementation(async () => undefined)
	gitMock.getCommitInfo.mockImplementation(async () => "commit info")
	gitMock.getWorkingState.mockImplementation(async () => "working state")
	vscodeMock.readText.mockImplementation(async () => "")
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	errorSpy.mockRestore()
})

// --- 1. openMention -----------------------------------------------------------

describe("openMention", () => {
	it("mention が無ければ何もしない", async () => {
		await openMention(CWD, undefined)

		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
		expect(openFile).not.toHaveBeenCalled()
	})

	it("ファイルパスはエディタで開く", async () => {
		await openMention(CWD, "/src/app.ts")

		expect(openFile).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src/app.ts"))
		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
	})

	it("エスケープされた空白は戻してから開く", async () => {
		await openMention(CWD, "/src/my\\ file.ts")

		expect(openFile).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src/my file.ts"))
	})

	it("末尾がスラッシュならエクスプローラで開く", async () => {
		await openMention(CWD, "/src/")

		expect(vscodeMock.executeCommand).toHaveBeenCalledExactlyOnceWith("revealInExplorer", {
			fsPath: path.resolve(CWD, "src"),
			path: path.resolve(CWD, "src"),
			scheme: "file",
		})
		expect(openFile).not.toHaveBeenCalled()
	})

	it("problems は問題ビューを開く", async () => {
		await openMention(CWD, "problems")

		expect(vscodeMock.executeCommand).toHaveBeenCalledExactlyOnceWith("workbench.actions.view.problems")
	})

	it("terminal はターミナルにフォーカスする", async () => {
		await openMention(CWD, "terminal")

		expect(vscodeMock.executeCommand).toHaveBeenCalledExactlyOnceWith("workbench.action.terminal.focus")
	})

	it("http から始まる mention は外部ブラウザで開く", async () => {
		await openMention(CWD, "https://example.com")

		expect(vscodeMock.openExternal).toHaveBeenCalledExactlyOnceWith({
			fsPath: "https://example.com",
			path: "https://example.com",
			scheme: "https",
		})
	})

	it("どれにも当てはまらない mention では何もしない", async () => {
		await openMention(CWD, "abc1234")

		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
		expect(openFile).not.toHaveBeenCalled()
		expect(vscodeMock.openExternal).not.toHaveBeenCalled()
	})
})

// --- 2. 最重要の不変条件：読みに行かない ---------------------------------------

describe("parseMentions - 存在しないファイルを読みに行かない", () => {
	it("**stat が失敗したら本文の取得経路には一切入らない**", async () => {
		fsMock.stat.mockRejectedValue(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))

		const result = await parseMentions("見て @/missing.txt", CWD)

		expectNoFileRead("存在しないファイル")
		expect(result.contentBlocks).toHaveLength(1)
		expect(result.contentBlocks[0]).toMatchObject({ type: "file", path: "missing.txt" })
		expect(result.contentBlocks[0].content).toContain('Failed to access path "missing.txt"')
		expect(result.contentBlocks[0].content).toContain("ENOENT: no such file")
	})

	it("存在しないフォルダ mention でも読みに行かず、type は folder になる", async () => {
		fsMock.stat.mockRejectedValue(new Error("ENOENT"))

		const result = await parseMentions("見て @/missing/", CWD)

		expectNoFileRead("存在しないフォルダ")
		expect(result.contentBlocks[0]).toMatchObject({ type: "folder", path: "missing/" })
	})

	it("stat が Error 以外を投げても読みに行かない", async () => {
		fsMock.stat.mockRejectedValue("EACCES-string")

		const result = await parseMentions("見て @/secret.txt", CWD)

		expectNoFileRead("非 Error")
		expect(result.contentBlocks[0].content).toContain("EACCES-string")
	})

	it("ファイルでもディレクトリでもない実体（FIFO 等）は読まない", async () => {
		fsMock.stat.mockResolvedValue(statAs("other"))

		const result = await parseMentions("見て @/dev-fifo", CWD)

		expectNoFileRead("特殊ファイル")
		expect(result.contentBlocks[0].content).toContain("Error: Unable to read (not a file or directory)")
		expect(result.contentBlocks[0].type).toBe("file")
	})

	it("末尾スラッシュ付きの特殊実体は folder として返す", async () => {
		fsMock.stat.mockResolvedValue(statAs("other"))

		const result = await parseMentions("見て @/weird/", CWD)

		expect(result.contentBlocks[0].type).toBe("folder")
	})

	it("非 Error が投げられても String 化して返す（現状は到達不能な防御コード）", async () => {
		// core/mentions/index.ts:196 の `String(error)` 側。
		// getFileOrFolderContentWithMetadata は失敗を必ず `new Error(...)` に包み直して
		// 投げる（index.ts:389）ので、通常の入力ではこの分岐に入る余地が無い。
		// ExecuteCommandTool.invariants.spec.ts と同じ手口で `instanceof` だけを偽装し、
		// 「非 Error でも文言を落とさない」という防御コードの意図を固定しておく。
		// 判定を曲げるのは「この関数が投げるメッセージ」に限定し、他の instanceof は素通しする。
		const NATIVE_HAS_INSTANCE = Function.prototype[Symbol.hasInstance]
		fsMock.stat.mockRejectedValue(new Error("ENOENT"))

		Object.defineProperty(Error, Symbol.hasInstance, {
			configurable: true,
			value: function (this: unknown, instance: unknown): boolean {
				const message = (instance as { message?: unknown } | null)?.message
				if (typeof message === "string" && message.startsWith("Failed to access path")) {
					return false
				}
				return NATIVE_HAS_INSTANCE.call(this, instance)
			},
		})

		let result: Awaited<ReturnType<typeof parseMentions>>
		try {
			result = await parseMentions("見て @/missing.txt", CWD)
		} finally {
			Reflect.deleteProperty(Error, Symbol.hasInstance)
		}

		expectNoFileRead("非 Error（偽装）")
		expect(result.contentBlocks[0].content).toContain('Error: Failed to access path "missing.txt"')
	})

	it("agentignore で拒否されたファイルは中身を読みに行かない", async () => {
		const rooIgnoreController = { validateAccess: vi.fn(() => false) }

		const result = await parseMentions("見て @/.env", CWD, undefined, rooIgnoreController as never)

		expect(rooIgnoreController.validateAccess).toHaveBeenCalledWith(".env")
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
		expect(result.contentBlocks[0].content).toContain("Note: File is ignored by .agentignore.")
	})

	it("バイナリファイルは中身を読みに行かない", async () => {
		isBinaryFile.mockResolvedValue(true)

		const result = await parseMentions("見て @/logo.png", CWD)

		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
		expect(result.contentBlocks[0].content).toContain("Note: Binary file omitted from context.")
	})

	it("バイナリ判定自体が失敗したらテキスト扱いにする", async () => {
		isBinaryFile.mockRejectedValue(new Error("EACCES"))

		const result = await parseMentions("見て @/app.ts", CWD)

		expect(extractTextFromFileWithMetadata).toHaveBeenCalledTimes(1)
		expect(result.contentBlocks[0].content).toContain("1 | hello")
	})
})

// --- 2.5 ワークスペース外への脱出を封じる --------------------------------------

describe("parseMentions - ワークスペース外への脱出", () => {
	/** 拒否時に返る本文（実装と 1 文字ずれたら落ちるよう、丸ごと突き合わせる）。 */
	const refusal = (mentionPath: string) =>
		`Error: refusing to read a mention that resolves outside the workspace: ${mentionPath}`

	it.each([
		// [ラベル, 入力テキスト, ブロックの path, ブロックの type]
		["`..` で親を辿る", "見て @/../../etc/passwd", "../../etc/passwd", "file"],
		["`..` で親を辿るフォルダ", "見て @/../../etc/", "../../etc/", "folder"],
		// mention は必ず `/` 始まりなので、`//etc/shadow` が「絶対パス風」の形になる。
		// path.resolve(cwd, "/etc/shadow") は cwd を無視して /etc/shadow になる。
		["絶対パス風の mention", "見て @//etc/shadow", "/etc/shadow", "file"],
		["ワークスペース内から抜け出す", "見て @/src/../../outside.txt", "src/../../outside.txt", "file"],
		// symlink 名を挟んでも、解決後が外なら同じ扱い（isPathInside は realpath を追わない。
		// リンクの実体が外を指す場合はここでは止まらない、という前提も込みで固定する）。
		["symlink 風の中継を挟む", "見て @/link/../../etc/hosts", "link/../../etc/hosts", "file"],
		["エスケープされた空白を含む外部パス", "見て @/../my\\ secret.txt", "../my\\ secret.txt", "file"],
		["末尾スラッシュで親そのものを指す", "見て @/../../", "../../", "folder"],
		// `@/../..` は mention 正規表現が末尾の `.` を句読点として切り落とすため `/../.` になる。
		// 解決先は cwd の親（= 外）なので、切り落とされても拒否は変わらない。
		["親そのものを指す", "見て @/../..", "../.", "file"],
	])("**【不変条件】%s: fs に触れずに拒否する**", async (label, text, mentionPath, type) => {
		const result = await parseMentions(text, CWD)

		expectNothingTouched(label)
		expect(result.contentBlocks).toHaveLength(1)
		expect(result.contentBlocks[0].type).toBe(type)
		expect(result.contentBlocks[0].path).toBe(mentionPath)
		expect(result.contentBlocks[0].content).toBe(refusal(mentionPath))
	})

	it("**【不変条件】拒否した mention は agentignore にもコンテキスト追跡にも渡さない**", async () => {
		// 「.agentignore が許した/拒んだ」の判断より前に落とす。
		// AgentIgnoreController.validateAccess は cwd 外のパスを後方互換のため通すので、
		// そこへ判断を委ねた時点で素通りする。
		const rooIgnoreController = { validateAccess: vi.fn(() => true) }
		const fileContextTracker = { trackFileContext: vi.fn(async () => undefined) }

		const result = await parseMentions(
			"見て @/../../../.ssh/id_rsa",
			CWD,
			fileContextTracker as never,
			rooIgnoreController as never,
		)

		expectNothingTouched("agentignore へ委譲しない")
		expect(rooIgnoreController.validateAccess).not.toHaveBeenCalled()
		expect(fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(result.contentBlocks[0].content).toBe(refusal("../../../.ssh/id_rsa"))
	})

	it("**【不変条件】外部 mention が混ざっても、内側の mention の処理は止めない**", async () => {
		const result = await parseMentions("@/src/app.ts と @/../../etc/passwd", CWD)

		// 内側は通常どおり読む。外側は拒否文だけ。
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src/app.ts"))
		const outside = result.contentBlocks.find((block) => block.path === "../../etc/passwd")
		expect(outside?.content).toBe(refusal("../../etc/passwd"))
		const inside = result.contentBlocks.find((block) => block.path === "src/app.ts")
		expect(inside?.content).toContain("1 | hello")
	})

	it("cwd の中に留まる `..` は通す（過剰に拒否しない）", async () => {
		await parseMentions("見て @/src/../src/app.ts", CWD)

		expect(extractTextFromFileWithMetadata).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src/app.ts"))
	})

	it("cwd 自身を指す mention は通す（同一パスは「中」）", async () => {
		fsMock.stat.mockResolvedValue(statAs("dir"))
		fsMock.readdir.mockResolvedValue([dirent("app.ts")])

		const result = await parseMentions("見て @/./ を", CWD)

		expect(fsMock.readdir).toHaveBeenCalledTimes(1)
		expect(result.contentBlocks[0].content).toContain("└── app.ts")
	})
})

// --- 3. ファイル mention の整形 ------------------------------------------------

describe("parseMentions - ファイル mention", () => {
	it("read_file の結果と同じ体裁で返し、本文からは @ を消す", async () => {
		const result = await parseMentions("見て @/src/app.ts ね", CWD)

		expect(result.text).toBe("見て 'src/app.ts' ね")
		expect(result.contentBlocks).toHaveLength(1)
		expect(result.contentBlocks[0].content).toBe("[read_file for 'src/app.ts']\nFile: src/app.ts\n1 | hello")
		expect(result.contentBlocks[0].metadata).toEqual({
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
			linesShown: undefined,
		})
	})

	it("打ち切られた場合は続きの読み方を明示する", async () => {
		extractTextFromFileWithMetadata.mockResolvedValue({
			content: "1 | a",
			totalLines: 5000,
			returnedLines: 2000,
			wasTruncated: true,
			linesShown: [1, 2000],
		})

		const result = await parseMentions("見て @/big.log", CWD)

		const content = result.contentBlocks[0].content
		expect(content).toContain("IMPORTANT: File content truncated.")
		expect(content).toContain("Status: Showing lines 1-2000 of 5000 total lines.")
		expect(content).toContain("Use the read_file tool with offset=2001 and limit=2000.")
	})

	it("linesShown が無ければ打ち切り扱いにしない", async () => {
		extractTextFromFileWithMetadata.mockResolvedValue({
			content: "1 | a",
			totalLines: 5000,
			returnedLines: 2000,
			wasTruncated: true,
		})

		const result = await parseMentions("見て @/big.log", CWD)

		expect(result.contentBlocks[0].content).not.toContain("IMPORTANT: File content truncated.")
	})

	it("読み込みに失敗しても他の mention を巻き込まない", async () => {
		extractTextFromFileWithMetadata.mockRejectedValue(new Error("decode failed"))

		const result = await parseMentions("見て @/broken.bin", CWD)

		expect(result.contentBlocks[0].content).toBe("[read_file for 'broken.bin']\nError: decode failed")
	})

	it("読み込みが Error 以外を投げても String 化して返す", async () => {
		extractTextFromFileWithMetadata.mockRejectedValue({ code: "EISDIR" })

		const result = await parseMentions("見て @/broken.bin", CWD)

		expect(result.contentBlocks[0].content).toContain("[object Object]")
	})

	it("読み込めたファイルはコンテキスト追跡に記録する", async () => {
		const fileContextTracker = { trackFileContext: vi.fn(async () => undefined) }

		await parseMentions("見て @/src/app.ts", CWD, fileContextTracker as never)

		expect(fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith("src/app.ts", "file_mentioned")
	})

	it("エスケープされた空白入りのパスも解決する", async () => {
		await parseMentions("見て @/src/my\\ file.ts", CWD)

		expect(extractTextFromFileWithMetadata).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src/my file.ts"))
	})

	it("同じ mention が 2 回出てきてもファイルは 1 回しか読まない", async () => {
		const result = await parseMentions("@/a.ts と @/a.ts", CWD)

		expect(extractTextFromFileWithMetadata).toHaveBeenCalledTimes(1)
		expect(result.contentBlocks).toHaveLength(1)
	})
})

// --- 4. フォルダ mention -------------------------------------------------------

describe("parseMentions - フォルダ mention", () => {
	beforeEach(() => {
		fsMock.stat.mockImplementation(async () => statAs("dir"))
	})

	it("ツリー表示とファイル本文をまとめて返す", async () => {
		fsMock.readdir.mockResolvedValue([dirent("a.ts"), dirent("nested", "dir"), dirent("b.ts")])

		const result = await parseMentions("見て @/src/", CWD)

		const content = result.contentBlocks[0].content
		expect(result.contentBlocks[0].type).toBe("folder")
		expect(content).toContain("[read_file for folder 'src/']")
		expect(content).toContain("├── a.ts")
		expect(content).toContain("├── nested/")
		// 最後の 1 件だけ枝が変わる。
		expect(content).toContain("└── b.ts")
		expect(content).toContain("--- File Contents ---")
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledTimes(2)
	})

	it("ファイルが 1 つも読めなければ本文セクションを付けない", async () => {
		fsMock.readdir.mockResolvedValue([dirent("sub", "dir")])

		const result = await parseMentions("見て @/src/", CWD)

		expect(result.contentBlocks[0].content).not.toContain("--- File Contents ---")
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
	})

	it("ファイルでもディレクトリでもないエントリは名前だけ並べる", async () => {
		fsMock.readdir.mockResolvedValue([dirent("socket", "other")])

		const result = await parseMentions("見て @/src/", CWD)

		expect(result.contentBlocks[0].content).toContain("└── socket")
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
	})

	it("バイナリのエントリは一覧に出すが本文は読まない", async () => {
		fsMock.readdir.mockResolvedValue([dirent("logo.png")])
		isBinaryFile.mockResolvedValue(true)

		const result = await parseMentions("見て @/assets/", CWD)

		expect(result.contentBlocks[0].content).toContain("└── logo.png")
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
	})

	it("読めないファイルがあっても一覧は完成する", async () => {
		fsMock.readdir.mockResolvedValue([dirent("bad.ts"), dirent("good.ts")])
		extractTextFromFileWithMetadata.mockImplementation(async (p: unknown) => {
			if (String(p).endsWith("bad.ts")) {
				throw new Error("boom")
			}
			return { content: "1 | ok", totalLines: 1, returnedLines: 1, wasTruncated: false }
		})

		const result = await parseMentions("見て @/src/", CWD)

		const content = result.contentBlocks[0].content
		expect(content).toContain("├── bad.ts")
		expect(content).toContain("└── good.ts")
		expect(content).toContain("1 | ok")
		expect(content).not.toContain("boom")
	})

	it("agentignore で拒否されたエントリは既定で一覧からも消える", async () => {
		fsMock.readdir.mockResolvedValue([dirent(".env"), dirent("app.ts")])
		const rooIgnoreController = {
			validateAccess: vi.fn((p: string) => !String(p).endsWith(".env")),
		}

		const result = await parseMentions("見て @/src/", CWD, undefined, rooIgnoreController as never)

		const content = result.contentBlocks[0].content
		expect(content).not.toContain(".env")
		expect(content).toContain("└── app.ts")
		// 一覧に出さないファイルは本文も読まない。
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src", "app.ts"))
	})

	it("showAgentIgnoredFiles なら鍵付きで一覧に出すが本文は読まない", async () => {
		fsMock.readdir.mockResolvedValue([dirent(".env"), dirent("sub", "dir"), dirent("app.ts")])
		const rooIgnoreController = {
			validateAccess: vi.fn((p: string) => !String(p).endsWith(".env") && !String(p).endsWith("sub")),
		}

		const result = await parseMentions("見て @/src/", CWD, undefined, rooIgnoreController as never, true)

		const content = result.contentBlocks[0].content
		expect(content).toContain("├── 🔒 .env")
		expect(content).toContain("├── 🔒 sub/")
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledExactlyOnceWith(path.resolve(CWD, "src", "app.ts"))
	})

	it("エントリの検査は絶対パスで行う", async () => {
		fsMock.readdir.mockResolvedValue([dirent("app.ts")])
		const rooIgnoreController = { validateAccess: vi.fn(() => true) }

		await parseMentions("見て @/src/", CWD, undefined, rooIgnoreController as never)

		expect(rooIgnoreController.validateAccess).toHaveBeenCalledExactlyOnceWith(
			path.join(path.resolve(CWD, "src"), "app.ts"),
		)
	})
})

// --- 5. 特殊 mention -----------------------------------------------------------

describe("parseMentions - 特殊 mention", () => {
	it("problems は診断結果を本文の末尾に付ける", async () => {
		const result = await parseMentions("直して @problems", CWD)

		expect(result.text).toContain("Workspace Problems (see below for diagnostics)")
		expect(result.text).toContain("<workspace_diagnostics>\nproblem list\n</workspace_diagnostics>")
		expect(diagnosticsToProblemsString).toHaveBeenCalledWith([], [0, 1], CWD, true, 50)
	})

	it("診断が空なら「無し」と明示する", async () => {
		diagnosticsToProblemsString.mockResolvedValue("")

		const result = await parseMentions("直して @problems", CWD)

		expect(result.text).toContain("No errors or warnings detected.")
	})

	it("診断のオプションはそのまま伝わる", async () => {
		await parseMentions("@problems", CWD, undefined, undefined, false, false, 5)

		expect(diagnosticsToProblemsString).toHaveBeenCalledWith([], [0, 1], CWD, false, 5)
	})

	it("診断の取得に失敗してもテキストは壊さない", async () => {
		diagnosticsToProblemsString.mockRejectedValue(new Error("diag boom"))

		const result = await parseMentions("@problems", CWD)

		expect(result.text).toContain("Error fetching diagnostics: diag boom")
	})

	it("git-changes は作業ツリーの状態を付ける", async () => {
		const result = await parseMentions("@git-changes を見て", CWD)

		expect(result.text).toContain("Working directory changes (see below for details)")
		expect(result.text).toContain("<git_working_state>\nworking state\n</git_working_state>")
		expect(gitMock.getWorkingState).toHaveBeenCalledExactlyOnceWith(CWD)
	})

	it("git-changes の取得に失敗しても続行する", async () => {
		gitMock.getWorkingState.mockRejectedValue(new Error("not a repo"))

		const result = await parseMentions("@git-changes", CWD)

		expect(result.text).toContain("Error fetching working state: not a repo")
	})

	it("コミットハッシュはコミット情報を付ける", async () => {
		const result = await parseMentions("@abc1234 を説明して", CWD)

		expect(result.text).toContain("Git commit 'abc1234' (see below for commit info)")
		expect(result.text).toContain('<git_commit hash="abc1234">\ncommit info\n</git_commit>')
		expect(gitMock.getCommitInfo).toHaveBeenCalledExactlyOnceWith("abc1234", CWD)
	})

	it("コミット情報の取得に失敗しても続行する", async () => {
		gitMock.getCommitInfo.mockRejectedValue(new Error("bad object"))

		const result = await parseMentions("@abc1234", CWD)

		expect(result.text).toContain("Error fetching commit info: bad object")
	})

	it("terminal はターミナル出力を付ける", async () => {
		vscodeMock.readText.mockResolvedValueOnce("ORIG").mockResolvedValueOnce("$ ls\nfile.txt")

		const result = await parseMentions("@terminal を見て", CWD)

		expect(result.text).toContain("Terminal Output (see below for output)")
		expect(result.text).toContain("<terminal_output>\n$ ls\n</terminal_output>")
	})

	it("ターミナル出力の取得に失敗しても続行する", async () => {
		vscodeMock.readText.mockRejectedValue(new Error("clipboard locked"))

		const result = await parseMentions("@terminal", CWD)

		expect(result.text).toContain("Error fetching terminal output: clipboard locked")
	})

	it("URL はクォートして残すだけで、取りに行かない", async () => {
		const result = await parseMentions("@https://example.com/a を見て", CWD)

		expect(result.text).toBe("'https://example.com/a' を見て")
		expect(result.contentBlocks).toEqual([])
	})

	it("http 以外のスキームは置換せずそのまま残す", async () => {
		const result = await parseMentions("@ftp://example.com/a を見て", CWD)

		expect(result.text).toBe("@ftp://example.com/a を見て")
		expect(result.contentBlocks).toEqual([])
	})

	it("mention が無ければ本文もブロックも変わらない", async () => {
		const result = await parseMentions("ただの文章です", CWD)

		expect(result).toEqual({
			text: "ただの文章です",
			contentBlocks: [],
			mode: undefined,
			slashCommandHelp: undefined,
		})
	})
})

// --- 6. スラッシュコマンドとスキル ---------------------------------------------

describe("parseMentions - スラッシュコマンド", () => {
	it("存在するコマンドは本文を差し替え、内容を別枠で返す", async () => {
		getCommand.mockResolvedValue(makeCommand({ description: "デプロイする" }))

		const result = await parseMentions("/deploy お願い", CWD)

		expect(result.text).toContain("Command 'deploy' (see below for command content)")
		expect(result.slashCommandHelp).toContain('<command name="deploy">')
		expect(result.slashCommandHelp).toContain("Description: デプロイする")
		expect(result.slashCommandHelp).toContain("deploy body")
	})

	it("description が無ければ本文だけ返す", async () => {
		getCommand.mockResolvedValue(makeCommand())

		const result = await parseMentions("/deploy", CWD)

		expect(result.slashCommandHelp).not.toContain("Description:")
		expect(result.slashCommandHelp).toContain("deploy body")
	})

	it("コマンドの mode は最初の 1 件だけ採用する", async () => {
		getCommand.mockImplementation(async (_cwd: unknown, name: unknown) => {
			if (name === "first") {
				return makeCommand({ name: "first", mode: "architect" })
			}
			return makeCommand({ name: "second", mode: "debug" })
		})

		const result = await parseMentions("/first /second", CWD)

		expect(result.mode).toBe("architect")
	})

	it("mode を持たないコマンドでは mode を返さない", async () => {
		getCommand.mockResolvedValue(makeCommand())

		const result = await parseMentions("/deploy", CWD)

		expect(result.mode).toBeUndefined()
	})

	it("存在しないコマンドは本文をそのまま残す", async () => {
		getCommand.mockResolvedValue(undefined)

		const result = await parseMentions("/nope お願い", CWD)

		expect(result.text).toBe("/nope お願い")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("コマンド探索が例外を投げても存在しない扱いにする", async () => {
		getCommand.mockRejectedValue(new Error("fs boom"))

		const result = await parseMentions("/nope", CWD)

		expect(result.text).toBe("/nope")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("コマンド本文の読み出しが失敗してもエラーとして枠に収める", async () => {
		getCommand.mockResolvedValue({
			...makeCommand(),
			get content(): string {
				throw new Error("read failed")
			},
		})

		const result = await parseMentions("/deploy", CWD)

		expect(result.slashCommandHelp).toContain("Error loading command 'deploy': read failed")
	})

	it("コマンドが無くてもスキルがあればスキルとして展開する", async () => {
		const skillsManager = { getSkillContent: vi.fn(async () => makeSkill()) }

		const result = await parseMentions(
			"/review して",
			CWD,
			undefined,
			undefined,
			false,
			true,
			50,
			skillsManager as never,
			"code",
		)

		expect(skillsManager.getSkillContent).toHaveBeenCalledWith("review", "code")
		expect(result.text).toContain("Command 'review' (see below for command content)")
		expect(result.slashCommandHelp).toContain("Skill: review")
		expect(result.slashCommandHelp).toContain("do the review")
	})

	it("スキルも見つからなければ本文はそのまま", async () => {
		const skillsManager = { getSkillContent: vi.fn(async () => null) }

		const result = await parseMentions(
			"/unknown",
			CWD,
			undefined,
			undefined,
			false,
			true,
			50,
			skillsManager as never,
		)

		expect(result.text).toBe("/unknown")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("同じコマンドを 2 回書いても探索は 1 回だけ", async () => {
		getCommand.mockResolvedValue(makeCommand())

		await parseMentions("/deploy と /deploy", CWD)

		expect(getCommand).toHaveBeenCalledTimes(1)
	})

	it("コマンドと @ mention が同居しても両方処理する", async () => {
		getCommand.mockResolvedValue(makeCommand())

		const result = await parseMentions("/deploy @/src/app.ts", CWD)

		expect(result.text).toContain("Command 'deploy' (see below for command content)")
		expect(result.text).toContain("'src/app.ts'")
		expect(result.contentBlocks).toHaveLength(1)
	})
})

// --- 7. ターミナル出力の取り込み -----------------------------------------------

describe("getLatestTerminalOutput", () => {
	it("直前のコマンド以降だけを切り出し、クリップボードを必ず戻す", async () => {
		vscodeMock.readText.mockResolvedValueOnce("ORIG").mockResolvedValueOnce("$ echo hi\nhi\n$ echo hi")

		const output = await getLatestTerminalOutput()

		expect(output).toBe("$ echo hi\nhi")
		expect(vscodeMock.executeCommand.mock.calls.map(([c]) => c)).toEqual([
			"workbench.action.terminal.selectAll",
			"workbench.action.terminal.copySelection",
			"workbench.action.terminal.clearSelection",
		])
		expect(vscodeMock.writeText).toHaveBeenCalledExactlyOnceWith("ORIG")
	})

	it("プロンプトが見つからなければ先頭から全部返す", async () => {
		vscodeMock.readText.mockResolvedValueOnce("ORIG").mockResolvedValueOnce("aaa\nbbb\nccc")

		expect(await getLatestTerminalOutput()).toBe("aaa\nbbb")
	})

	it("ターミナルが開いていなければ空文字を返す", async () => {
		vscodeMock.readText.mockResolvedValue("ORIG")

		expect(await getLatestTerminalOutput()).toBe("")
		expect(vscodeMock.writeText).toHaveBeenCalledExactlyOnceWith("ORIG")
	})

	it("空の出力でも壊れない", async () => {
		vscodeMock.readText.mockResolvedValueOnce("ORIG").mockResolvedValueOnce("   ")

		expect(await getLatestTerminalOutput()).toBe("")
	})

	it("**途中で失敗してもクリップボードは元に戻す**", async () => {
		vscodeMock.readText.mockResolvedValueOnce("ORIG")
		vscodeMock.executeCommand.mockRejectedValueOnce(new Error("no terminal"))

		await expect(getLatestTerminalOutput()).rejects.toThrow("no terminal")

		expect(vscodeMock.writeText).toHaveBeenCalledExactlyOnceWith("ORIG")
	})
})
