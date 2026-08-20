// npx vitest run core/webview/__tests__/fileEditorMessageHandlers.spec.ts
//
// fileEditorMessageHandlers は webview からの「開く・読む・保存する・探す」を
// エディタ側へ流す層。ディスクへ書くのはデバッグ履歴と Markdown プレビューの
// 一時ファイル 2 か所だけなので、そこを不変条件として固定する。
//
//   1. fs.writeFile に渡った「全パス」が os.tmpdir() 直下から出ないこと。
//      タスク ID にセパレータや ".." が入っていても抜けないこと。
//   2. ワークスペース外のファイルを読まないこと（readFileContent）。
//   3. 一時ファイルの中身が「読み出した JSON を整形したもの」以上でないこと。
//
// 1 のうち「タスク ID が汚染された場合」は、このファイル自身にはガードが無く、
// utils/storage の getTaskDirectoryPath（isSafeTaskId）に完全に依存している。
// 依存していること自体をテストで可視化し、ガードを外すと tmpdir の外へ書けることも
// 【バグ／防御の欠如】として固定する。

import * as path from "path"
import * as os from "os"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { WebviewMessage } from "@openai-agent/types"

import { fileEditorMessageHandlers } from "../fileEditorMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const {
	readFileMock,
	writeFileMock,
	openFileMock,
	openImageMock,
	saveImageMock,
	selectImagesMock,
	searchWorkspaceFilesMock,
	fileExistsAtPathMock,
	searchCommitsMock,
	isPathOutsideWorkspaceMock,
	resolveDefaultSaveUriMock,
	saveLastExportPathMock,
	openMentionMock,
	generateErrorDiagnosticsMock,
	getTaskDirectoryPathMock,
	ignoreInitializeMock,
	ignoreFilterPathsMock,
	ignoreDisposeMock,
	ignoreCtorMock,
	showErrorMessageMock,
	showTextDocumentMock,
	openTextDocumentMock,
	executeCommandMock,
	openExternalMock,
	uriFileMock,
	uriParseMock,
} = vi.hoisted(() => ({
	readFileMock: vi.fn(async (..._args: unknown[]) => "" as string),
	writeFileMock: vi.fn(async (..._args: unknown[]) => undefined),
	openFileMock: vi.fn(),
	openImageMock: vi.fn(),
	saveImageMock: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	selectImagesMock: vi.fn(async () => [] as string[]),
	searchWorkspaceFilesMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
	fileExistsAtPathMock: vi.fn(async (..._args: unknown[]) => true),
	searchCommitsMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
	isPathOutsideWorkspaceMock: vi.fn((..._args: unknown[]) => false),
	resolveDefaultSaveUriMock: vi.fn((..._args: unknown[]) => ({ fsPath: "/downloads/img.png" })),
	saveLastExportPathMock: vi.fn(async (..._args: unknown[]) => undefined),
	openMentionMock: vi.fn(),
	generateErrorDiagnosticsMock: vi.fn(async (..._args: unknown[]) => ({})),
	getTaskDirectoryPathMock: vi.fn(async (..._args: unknown[]) => ""),
	ignoreInitializeMock: vi.fn(async () => undefined),
	ignoreFilterPathsMock: vi.fn((paths: string[]) => paths),
	ignoreDisposeMock: vi.fn(),
	ignoreCtorMock: vi.fn(),
	showErrorMessageMock: vi.fn(),
	showTextDocumentMock: vi.fn(async (..._args: unknown[]) => undefined),
	openTextDocumentMock: vi.fn(async (filePath: string) => ({ uri: { fsPath: filePath }, fsPath: filePath })),
	executeCommandMock: vi.fn(async (..._args: unknown[]) => undefined),
	openExternalMock: vi.fn(async (..._args: unknown[]) => true),
	uriFileMock: vi.fn((p: string) => ({ fsPath: p, scheme: "file" })),
	uriParseMock: vi.fn((p: string) => ({ fsPath: p, scheme: "https" })),
}))

// 実装は `import * as fs from "fs/promises"` の名前空間 import。default も生やしておく。
vi.mock("fs/promises", () => {
	const api = { readFile: readFileMock, writeFile: writeFileMock }
	return { ...api, default: api }
})

vi.mock("vscode", () => ({
	window: { showErrorMessage: showErrorMessageMock, showTextDocument: showTextDocumentMock },
	workspace: { workspaceFolders: [] as unknown[], openTextDocument: openTextDocumentMock },
	commands: { executeCommand: executeCommandMock },
	env: { openExternal: openExternalMock },
	Uri: { file: uriFileMock, parse: uriParseMock },
}))

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))
vi.mock("../../../integrations/misc/open-file", () => ({ openFile: openFileMock }))
vi.mock("../../../integrations/misc/image-handler", () => ({ openImage: openImageMock, saveImage: saveImageMock }))
vi.mock("../../../integrations/misc/process-images", () => ({ selectImages: selectImagesMock }))
vi.mock("../../../services/search/file-search", () => ({ searchWorkspaceFiles: searchWorkspaceFilesMock }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: fileExistsAtPathMock }))
vi.mock("../../../utils/git", () => ({ searchCommits: searchCommitsMock }))
// isPathOutsideWorkspace だけ差し替える。他の export（utils/storage が使う
// isSafePathSegment など）は本物を残さないと、storage 側の実ガードが動かなくなる。
vi.mock("../../../utils/pathUtils", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/pathUtils")>("../../../utils/pathUtils")
	return { ...actual, isPathOutsideWorkspace: isPathOutsideWorkspaceMock }
})
vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: resolveDefaultSaveUriMock,
	saveLastExportPath: saveLastExportPathMock,
}))
vi.mock("../../mentions", () => ({ openMention: openMentionMock }))
vi.mock("../diagnosticsHandler", () => ({ generateErrorDiagnostics: generateErrorDiagnosticsMock }))

// getTaskDirectoryPath だけスタブにする。isSafeTaskId は本物を使いたいので actual を残す。
vi.mock("../../../utils/storage", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/storage")>("../../../utils/storage")
	return { ...actual, getTaskDirectoryPath: getTaskDirectoryPathMock }
})

vi.mock("../../ignore/AgentIgnoreController", () => ({
	AgentIgnoreController: class {
		constructor(workspacePath: string) {
			ignoreCtorMock(workspacePath)
		}
		initialize = ignoreInitializeMock
		filterPaths = ignoreFilterPathsMock
		dispose = ignoreDisposeMock
	},
}))

import { isSafeTaskId } from "../../../utils/storage"

// ---------------------------------------------------------------------------
// 定数 / ヘルパ
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/workspace/project"
const GLOBAL_STORAGE_DIR = "/global-storage"
const TMP_DIR = os.tmpdir()
const FIXED_NOW = 1_700_000_000_000

/** fs.writeFile に渡った第 1 引数を呼ばれた順に全件返す。 */
const writeFilePaths = (): string[] => writeFileMock.mock.calls.map((call) => call[0] as string)

/** fs.readFile に渡った第 1 引数を呼ばれた順に全件返す。 */
const readFilePaths = (): string[] => readFileMock.mock.calls.map((call) => call[0] as string)

/**
 * 渡されたパス群が全て `<dir>/<1 セグメント>` の形であることを検査する。
 * TaskDeletionController.spec.ts の expectAllRmPathsInsideTasksDir と同じ形。
 */
function expectAllPathsDirectlyUnder(paths: string[], dir: string): void {
	const resolvedDir = path.resolve(dir)
	for (const p of paths) {
		expect(path.isAbsolute(p)).toBe(true)
		const resolved = path.resolve(p)
		expect(path.dirname(resolved)).toBe(resolvedDir)
		const segment = path.basename(resolved)
		expect(segment).not.toBe("")
		expect(segment).not.toBe(".")
		expect(segment).not.toBe("..")
		expect(resolved).toBe(path.join(resolvedDir, segment))
	}
}

interface FakeTask {
	taskId?: string
	cwd?: string
	rooIgnoreController?: { filterPaths: (paths: string[]) => string[]; dispose?: () => void }
}

interface ProviderOptions {
	cwd?: string
	task?: FakeTask
	getStateImpl?: () => Promise<Record<string, unknown> | null>
}

function makeProvider(options: ProviderOptions = {}) {
	const log = vi.fn()
	const postMessageToWebview = vi.fn(async (..._args: unknown[]) => undefined)
	const getState = vi.fn(options.getStateImpl ?? (async () => ({}) as Record<string, unknown> | null))
	const getCurrentTask = vi.fn(() => options.task)

	// 実際に触るメンバだけを持つ最小の fake。
	const provider = {
		cwd: options.cwd ?? WORKSPACE_DIR,
		contextProxy: { globalStorageUri: { fsPath: GLOBAL_STORAGE_DIR } },
		log,
		postMessageToWebview,
		getState,
		getCurrentTask,
	} as unknown as WebviewMessageHost

	return { provider, log, postMessageToWebview, getState, getCurrentTask }
}

const msg = (message: Record<string, unknown>): WebviewMessage => message as unknown as WebviewMessage

function handler(type: string) {
	const fn = (fileEditorMessageHandlers as Record<string, unknown>)[type]
	if (typeof fn !== "function") {
		throw new Error(`handler not registered: ${type}`)
	}
	return fn as (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>
}

let nowSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	readFileMock.mockImplementation(async () => "")
	writeFileMock.mockImplementation(async () => undefined)
	fileExistsAtPathMock.mockImplementation(async () => true)
	isPathOutsideWorkspaceMock.mockImplementation(() => false)
	saveImageMock.mockImplementation(async () => undefined)
	selectImagesMock.mockImplementation(async () => [])
	searchWorkspaceFilesMock.mockImplementation(async () => [])
	searchCommitsMock.mockImplementation(async () => [])
	resolveDefaultSaveUriMock.mockImplementation(() => ({ fsPath: "/downloads/img.png" }))
	generateErrorDiagnosticsMock.mockImplementation(async () => ({}))
	ignoreFilterPathsMock.mockImplementation((paths: string[]) => paths)
	openTextDocumentMock.mockImplementation(async (filePath: string) => ({
		uri: { fsPath: filePath },
		fsPath: filePath,
	}))
	// 一時ファイル名にタイムスタンプが入るので固定する。
	getTaskDirectoryPathMock.mockImplementation(async (...args: unknown[]) => {
		// 本物と同じガード。ここを外したケースは専用テストで別途扱う。
		const taskId = args[1]
		if (!isSafeTaskId(taskId)) {
			throw new Error(`Refusing to build a task directory path for an unsafe task id: ${JSON.stringify(taskId)}`)
		}
		return path.join(args[0] as string, "tasks", taskId)
	})
	nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW)
})

afterEach(() => {
	nowSpy.mockRestore()
})

// ---------------------------------------------------------------------------

describe("fileEditorMessageHandlers", () => {
	describe("openFile", () => {
		it("絶対パスはそのまま渡す", async () => {
			const h = makeProvider()

			await handler("openFile")(h.provider, msg({ type: "openFile", text: "/abs/file.ts", values: { line: 3 } }))

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith("/abs/file.ts", { line: 3 })
		})

		it("相対パスは cwd 基準で絶対化する", async () => {
			const h = makeProvider()

			await handler("openFile")(h.provider, msg({ type: "openFile", text: "src/a.ts" }))

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith(path.join(WORKSPACE_DIR, "src/a.ts"), undefined)
		})

		it("実行中タスクの cwd を優先する", async () => {
			const h = makeProvider({ task: { cwd: "/task/cwd" } })

			await handler("openFile")(h.provider, msg({ type: "openFile", text: "a.ts" }))

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith(path.join("/task/cwd", "a.ts"), undefined)
		})

		it("タスクの cwd が空文字なら provider の cwd に落ちる", async () => {
			const h = makeProvider({ task: { cwd: "" }, cwd: "/fallback" })

			await handler("openFile")(h.provider, msg({ type: "openFile", text: "a.ts" }))

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith(path.join("/fallback", "a.ts"), undefined)
		})
	})

	describe("readFileContent（不変条件 2）", () => {
		it("ワークスペース内のファイルなら中身を返す", async () => {
			const h = makeProvider()
			readFileMock.mockResolvedValue("hello")

			await handler("readFileContent")(h.provider, msg({ type: "readFileContent", text: "src/a.ts" }))

			expect(readFilePaths()).toEqual([path.resolve(WORKSPACE_DIR, "src/a.ts")])
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileContent",
				fileContent: { path: "src/a.ts", content: "hello" },
			})
		})

		it.each([
			["text 未指定", undefined],
			["空文字", ""],
		])("%s なら読まずにエラーを返す", async (_label, text) => {
			const h = makeProvider()

			await handler("readFileContent")(h.provider, msg({ type: "readFileContent", text }))

			expect(readFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileContent",
				fileContent: { path: "", content: null, error: "No path provided" },
			})
		})

		it("cwd が無ければ読まずにエラーを返す", async () => {
			const h = makeProvider({ cwd: "" })

			await handler("readFileContent")(h.provider, msg({ type: "readFileContent", text: "a.ts" }))

			expect(readFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileContent",
				fileContent: { path: "a.ts", content: null, error: "No workspace path available" },
			})
		})

		it("【不変条件】ワークスペース外を指すパスは fs.readFile まで届かない", async () => {
			const h = makeProvider()
			isPathOutsideWorkspaceMock.mockReturnValue(true)

			await handler("readFileContent")(h.provider, msg({ type: "readFileContent", text: "../../../etc/passwd" }))

			expect(readFileMock).not.toHaveBeenCalled()
			// 判定に渡るのは正規化済みの絶対パス（".." が残ったままではない）。
			expect(isPathOutsideWorkspaceMock).toHaveBeenCalledExactlyOnceWith(
				path.resolve(WORKSPACE_DIR, "../../../etc/passwd"),
			)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileContent",
				fileContent: { path: "../../../etc/passwd", content: null, error: "Path is outside workspace" },
			})
		})

		it.each([
			["Error", new Error("EACCES"), "EACCES"],
			["Error 以外", "raw-failure", "raw-failure"],
		])("読み込みが %s で失敗したらメッセージだけ返す", async (_label, thrown, expected) => {
			const h = makeProvider()
			readFileMock.mockRejectedValue(thrown)

			await handler("readFileContent")(h.provider, msg({ type: "readFileContent", text: "a.ts" }))

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileContent",
				fileContent: { path: "a.ts", content: null, error: expected },
			})
		})
	})

	describe("openMention / openExternal / openImage", () => {
		it("openMention は cwd とテキストを渡す", async () => {
			const h = makeProvider({ task: { cwd: "/task/cwd" } })

			await handler("openMention")(h.provider, msg({ type: "openMention", text: "@/src/a.ts" }))

			expect(openMentionMock).toHaveBeenCalledExactlyOnceWith("/task/cwd", "@/src/a.ts")
		})

		it("openExternal は url があれば開く", async () => {
			const h = makeProvider()

			await handler("openExternal")(h.provider, msg({ type: "openExternal", url: "https://example.com" }))

			expect(uriParseMock).toHaveBeenCalledExactlyOnceWith("https://example.com")
			expect(openExternalMock).toHaveBeenCalledOnce()
		})

		it("openExternal は url が無ければ何もしない", async () => {
			const h = makeProvider()

			await handler("openExternal")(h.provider, msg({ type: "openExternal" }))

			expect(openExternalMock).not.toHaveBeenCalled()
			expect(uriParseMock).not.toHaveBeenCalled()
		})

		it("openImage は values をそのまま渡す", async () => {
			const h = makeProvider()

			await handler("openImage")(
				h.provider,
				msg({ type: "openImage", text: "data:image/png;base64,AAA", values: { action: "save" } }),
			)

			expect(openImageMock).toHaveBeenCalledExactlyOnceWith("data:image/png;base64,AAA", {
				values: { action: "save" },
			})
		})
	})

	describe("saveImage", () => {
		it("data URI が無ければ何もしない", async () => {
			const h = makeProvider()

			await handler("saveImage")(h.provider, msg({ type: "saveImage" }))

			expect(saveImageMock).not.toHaveBeenCalled()
			expect(resolveDefaultSaveUriMock).not.toHaveBeenCalled()
		})

		it("data URI の形式が不正なら空 Uri で saveImage に判断を委ねる", async () => {
			const h = makeProvider()

			await handler("saveImage")(h.provider, msg({ type: "saveImage", dataUri: "not-a-data-uri" }))

			expect(uriFileMock).toHaveBeenCalledExactlyOnceWith("")
			expect(saveImageMock).toHaveBeenCalledExactlyOnceWith("not-a-data-uri", { fsPath: "", scheme: "file" })
			expect(resolveDefaultSaveUriMock).not.toHaveBeenCalled()
			expect(saveLastExportPathMock).not.toHaveBeenCalled()
		})

		it("拡張子は data URI の MIME から決め、保存できたら最終保存先を覚える", async () => {
			const h = makeProvider()
			const savedUri = { fsPath: "/downloads/img_1700000000000.webp" }
			saveImageMock.mockResolvedValue(savedUri)

			await handler("saveImage")(h.provider, msg({ type: "saveImage", dataUri: "data:image/webp;base64,QUJD" }))

			expect(resolveDefaultSaveUriMock).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				"lastImageSavePath",
				`img_${FIXED_NOW}.webp`,
				{ useWorkspace: false, fallbackDir: path.join(os.homedir(), "Downloads") },
			)
			expect(saveLastExportPathMock).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				"lastImageSavePath",
				savedUri,
			)
		})

		it("保存がキャンセルされたら最終保存先は更新しない", async () => {
			const h = makeProvider()
			saveImageMock.mockResolvedValue(undefined)

			await handler("saveImage")(h.provider, msg({ type: "saveImage", dataUri: "data:image/png;base64,QUJD" }))

			expect(saveImageMock).toHaveBeenCalledOnce()
			expect(saveLastExportPathMock).not.toHaveBeenCalled()
		})
	})

	describe("selectImages / insertTextIntoTextarea / openKeyboardShortcuts", () => {
		it("selectImages は選択結果を context / messageTs つきで返す", async () => {
			const h = makeProvider()
			selectImagesMock.mockResolvedValue(["data:image/png;base64,AAA"])

			await handler("selectImages")(h.provider, msg({ type: "selectImages", context: "chat", messageTs: 123 }))

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "selectedImages",
				images: ["data:image/png;base64,AAA"],
				context: "chat",
				messageTs: 123,
			})
		})

		it.each([
			["text 未指定", undefined],
			["空文字", ""],
		])("insertTextIntoTextarea は %s なら何も送らない", async (_label, text) => {
			const h = makeProvider()

			await handler("insertTextIntoTextarea")(h.provider, msg({ type: "insertTextIntoTextarea", text }))

			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("insertTextIntoTextarea はテキストをそのまま返す", async () => {
			const h = makeProvider()

			await handler("insertTextIntoTextarea")(h.provider, msg({ type: "insertTextIntoTextarea", text: "hello" }))

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "insertTextIntoTextarea",
				text: "hello",
			})
		})

		it.each([
			["検索語あり", "agent", ["workbench.action.openGlobalKeybindings", "agent"]],
			["検索語なし（未指定）", undefined, ["workbench.action.openGlobalKeybindings"]],
			["検索語なし（空文字）", "", ["workbench.action.openGlobalKeybindings"]],
		])("openKeyboardShortcuts: %s", async (_label, text, expected) => {
			const h = makeProvider()

			await handler("openKeyboardShortcuts")(h.provider, msg({ type: "openKeyboardShortcuts", text }))

			expect(executeCommandMock.mock.calls).toEqual([expected])
		})
	})

	describe("openMarkdownPreview（不変条件 1）", () => {
		it("【不変条件】一時ファイルは os.tmpdir() 直下にしか作られない", async () => {
			const h = makeProvider()

			await handler("openMarkdownPreview")(h.provider, msg({ type: "openMarkdownPreview", text: "# タイトル" }))

			const expected = path.join(TMP_DIR, `roo-preview-${FIXED_NOW}.md`)
			expect(writeFilePaths()).toEqual([expected])
			expectAllPathsDirectlyUnder(writeFilePaths(), TMP_DIR)
			expect(writeFileMock).toHaveBeenCalledExactlyOnceWith(expected, "# タイトル", "utf8")
			expect(openTextDocumentMock).toHaveBeenCalledExactlyOnceWith(expected)
			expect(executeCommandMock).toHaveBeenCalledExactlyOnceWith("markdown.showPreview", {
				fsPath: expected,
			})
		})

		it("【不変条件】本文に改行やパス区切りが入っても書き込み先は変わらない", async () => {
			// 一時ファイル名は Date.now() のみで決まる＝入力から独立していることの固定。
			const h = makeProvider()

			await handler("openMarkdownPreview")(
				h.provider,
				msg({ type: "openMarkdownPreview", text: "../../../etc/passwd\n\0/root/.ssh/id_rsa" }),
			)

			expect(writeFilePaths()).toEqual([path.join(TMP_DIR, `roo-preview-${FIXED_NOW}.md`)])
			expectAllPathsDirectlyUnder(writeFilePaths(), TMP_DIR)
		})

		it.each([
			["text 未指定", undefined],
			["空文字", ""],
		])("%s なら一時ファイルを作らない", async (_label, text) => {
			const h = makeProvider()

			await handler("openMarkdownPreview")(h.provider, msg({ type: "openMarkdownPreview", text }))

			expect(writeFileMock).not.toHaveBeenCalled()
			expect(openTextDocumentMock).not.toHaveBeenCalled()
		})

		it.each([
			["Error", new Error("ENOSPC"), "ENOSPC"],
			["Error 以外", { code: "EROFS" }, "[object Object]"],
		])("書き込みが %s で失敗したらログとエラー表示で握り潰す", async (_label, thrown, expected) => {
			const h = makeProvider()
			writeFileMock.mockRejectedValue(thrown)

			await handler("openMarkdownPreview")(h.provider, msg({ type: "openMarkdownPreview", text: "x" }))

			expect(h.log).toHaveBeenCalledWith(`Error opening markdown preview: ${expected}`)
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(`Failed to open markdown preview: ${expected}`)
			expect(openTextDocumentMock).not.toHaveBeenCalled()
		})
	})

	describe("searchCommits", () => {
		it("cwd が無ければ検索しない", async () => {
			const h = makeProvider({ cwd: "" })

			await handler("searchCommits")(h.provider, msg({ type: "searchCommits", query: "fix" }))

			expect(searchCommitsMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("検索結果を返す（query 未指定なら空文字）", async () => {
			const h = makeProvider()
			searchCommitsMock.mockResolvedValue([{ hash: "abc", subject: "fix" }])

			await handler("searchCommits")(h.provider, msg({ type: "searchCommits" }))

			expect(searchCommitsMock).toHaveBeenCalledExactlyOnceWith("", WORKSPACE_DIR)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "commitSearchResults",
				commits: [{ hash: "abc", subject: "fix" }],
			})
		})

		it("query を渡した場合はそのまま検索する", async () => {
			const h = makeProvider()

			await handler("searchCommits")(h.provider, msg({ type: "searchCommits", query: "fix" }))

			expect(searchCommitsMock).toHaveBeenCalledExactlyOnceWith("fix", WORKSPACE_DIR)
		})

		it("検索が失敗したらログとエラー表示で握り潰す", async () => {
			const h = makeProvider()
			searchCommitsMock.mockRejectedValue(new Error("not a git repo"))

			await handler("searchCommits")(h.provider, msg({ type: "searchCommits", query: "fix" }))

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error searching commits"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("not a git repo"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.search_commits")
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})
	})

	describe("searchFiles", () => {
		it("ワークスペースが無ければエラーを返す", async () => {
			const h = makeProvider({ cwd: "" })

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "a", requestId: "r1" }))

			expect(searchWorkspaceFilesMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileSearchResults",
				results: [],
				requestId: "r1",
				error: "No workspace path available",
			})
		})

		it("タスクの AgentIgnoreController があれば使い、dispose はしない", async () => {
			const taskFilterPaths = vi.fn(() => ["src/a.ts"])
			const taskDispose = vi.fn()
			const h = makeProvider({
				task: {
					cwd: WORKSPACE_DIR,
					rooIgnoreController: { filterPaths: taskFilterPaths, dispose: taskDispose },
				},
				getStateImpl: async () => ({ showAgentIgnoredFiles: false }),
			})
			searchWorkspaceFilesMock.mockResolvedValue([
				{ path: "src/a.ts", type: "file", label: "a.ts" },
				{ path: "secret/b.ts", type: "file", label: "b.ts" },
			])

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "a", requestId: "r2" }))

			expect(searchWorkspaceFilesMock).toHaveBeenCalledExactlyOnceWith("a", WORKSPACE_DIR, 20)
			expect(taskFilterPaths).toHaveBeenCalledExactlyOnceWith(["src/a.ts", "secret/b.ts"])
			expect(ignoreCtorMock).not.toHaveBeenCalled()
			expect(taskDispose).not.toHaveBeenCalled()
			expect(ignoreDisposeMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileSearchResults",
				results: [{ path: "src/a.ts", type: "file", label: "a.ts" }],
				requestId: "r2",
			})
		})

		it("タスクが無ければ一時 controller を作り、必ず dispose する", async () => {
			const h = makeProvider({ getStateImpl: async () => ({ showAgentIgnoredFiles: false }) })
			searchWorkspaceFilesMock.mockResolvedValue([{ path: "src/a.ts", type: "file", label: "a.ts" }])
			ignoreFilterPathsMock.mockReturnValue(["src/a.ts"])

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "a", requestId: "r3" }))

			expect(ignoreCtorMock).toHaveBeenCalledExactlyOnceWith(WORKSPACE_DIR)
			expect(ignoreInitializeMock).toHaveBeenCalledOnce()
			expect(ignoreDisposeMock).toHaveBeenCalledOnce()
		})

		it("結果の送信が失敗しても一時 controller は dispose される（finally）", async () => {
			const h = makeProvider({ getStateImpl: async () => ({ showAgentIgnoredFiles: true }) })
			searchWorkspaceFilesMock.mockResolvedValue([{ path: "src/a.ts", type: "file", label: "a.ts" }])
			let call = 0
			h.postMessageToWebview.mockImplementation(async () => {
				call += 1
				if (call === 1) {
					throw new Error("post boom")
				}
				return undefined
			})

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "a", requestId: "r4" }))

			expect(ignoreDisposeMock).toHaveBeenCalledOnce()
			// catch 側で 2 回目の postMessageToWebview（エラー返信）が走る。
			expect(h.postMessageToWebview).toHaveBeenCalledTimes(2)
			expect(h.postMessageToWebview.mock.calls[1]![0]).toEqual({
				type: "fileSearchResults",
				results: [],
				error: "post boom",
				requestId: "r4",
			})
		})

		it("showAgentIgnoredFiles が true ならフィルタしない", async () => {
			const results = [{ path: "secret/b.ts", type: "file", label: "b.ts" }]
			const h = makeProvider({ getStateImpl: async () => ({ showAgentIgnoredFiles: true }) })
			searchWorkspaceFilesMock.mockResolvedValue(results)

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "b", requestId: "r5" }))

			expect(ignoreFilterPathsMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileSearchResults",
				results,
				requestId: "r5",
			})
		})

		it("state が null でも既定でフィルタする（隠すのが既定）", async () => {
			const h = makeProvider({ getStateImpl: async () => null })
			searchWorkspaceFilesMock.mockResolvedValue([{ path: "src/a.ts", type: "file", label: "a.ts" }])
			ignoreFilterPathsMock.mockReturnValue([])

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", query: "a", requestId: "r6" }))

			expect(ignoreFilterPathsMock).toHaveBeenCalledOnce()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileSearchResults",
				results: [],
				requestId: "r6",
			})
		})

		it("検索そのものが失敗したらエラーを返す（query 未指定は空文字）", async () => {
			const h = makeProvider()
			searchWorkspaceFilesMock.mockRejectedValue(new Error("ripgrep failed"))

			await handler("searchFiles")(h.provider, msg({ type: "searchFiles", requestId: "r7" }))

			expect(searchWorkspaceFilesMock).toHaveBeenCalledExactlyOnceWith("", WORKSPACE_DIR, 20)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "fileSearchResults",
				results: [],
				error: "ripgrep failed",
				requestId: "r7",
			})
		})
	})

	describe("openDebugApiHistory / openDebugUiHistory（不変条件 1・3）", () => {
		const TASK_ID = "1234abcd-5678-90ef-1234-567890abcdef"
		const taskDir = path.join(GLOBAL_STORAGE_DIR, "tasks", TASK_ID)

		it("2 つのキーは同じ実装を共有している", () => {
			expect(fileEditorMessageHandlers.openDebugApiHistory).toBe(fileEditorMessageHandlers.openDebugUiHistory)
		})

		it("実行中タスクが無ければ何も読まない・書かない", async () => {
			const h = makeProvider()

			await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("No active task to view history for")
			expect(readFileMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it("【不変条件】api 履歴の一時ファイルは os.tmpdir() 直下に整形済み JSON だけを書く", async () => {
			const h = makeProvider({ task: { taskId: TASK_ID } })
			readFileMock.mockResolvedValue('{"b":2,"a":[1,2]}')

			await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

			expect(getTaskDirectoryPathMock).toHaveBeenCalledExactlyOnceWith(GLOBAL_STORAGE_DIR, TASK_ID)
			expect(readFilePaths()).toEqual([path.join(taskDir, "api_conversation_history.json")])

			const expected = path.join(TMP_DIR, `roo-debug-api-1234abcd-${FIXED_NOW}.json`)
			expect(writeFilePaths()).toEqual([expected])
			expectAllPathsDirectlyUnder(writeFilePaths(), TMP_DIR)
			// 中身は読み出した JSON を整形しただけ（別の値を混ぜない）。
			expect(writeFileMock).toHaveBeenCalledExactlyOnceWith(
				expected,
				JSON.stringify({ b: 2, a: [1, 2] }, null, 2),
				"utf8",
			)
			expect(openTextDocumentMock).toHaveBeenCalledExactlyOnceWith(expected)
			expect(showTextDocumentMock).toHaveBeenCalledExactlyOnceWith(
				{ uri: { fsPath: expected }, fsPath: expected },
				{ preview: true },
			)
		})

		it("ui 履歴は別のソースファイルと別の一時ファイル名を使う", async () => {
			const h = makeProvider({ task: { taskId: TASK_ID } })
			readFileMock.mockResolvedValue("[]")

			await handler("openDebugUiHistory")(h.provider, msg({ type: "openDebugUiHistory" }))

			expect(readFilePaths()).toEqual([path.join(taskDir, "ui_messages.json")])
			expect(writeFilePaths()).toEqual([path.join(TMP_DIR, `roo-debug-ui-1234abcd-${FIXED_NOW}.json`)])
			expectAllPathsDirectlyUnder(writeFilePaths(), TMP_DIR)
		})

		it.each([
			["api", "openDebugApiHistory", "api_conversation_history.json"],
			["ui", "openDebugUiHistory", "ui_messages.json"],
		])("%s: ソースファイルが無ければ一時ファイルを作らない", async (_label, type, fileName) => {
			const h = makeProvider({ task: { taskId: TASK_ID } })
			fileExistsAtPathMock.mockResolvedValue(false)

			await handler(type)(h.provider, msg({ type }))

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(`File not found: ${fileName}`)
			expect(readFileMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it("JSON として壊れていたら一時ファイルを作らない", async () => {
			const h = makeProvider({ task: { taskId: TASK_ID } })
			readFileMock.mockResolvedValue("{ broken")

			await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				"Failed to parse api_conversation_history.json",
			)
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it.each([
			["Error", new Error("EMFILE"), "EMFILE"],
			["Error 以外", "raw", "raw"],
		])("読み込みが %s で失敗したらログとエラー表示で握り潰す", async (_label, thrown, expected) => {
			const h = makeProvider({ task: { taskId: TASK_ID } })
			readFileMock.mockRejectedValue(thrown)

			await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

			expect(h.log).toHaveBeenCalledWith(`Error opening debug history: ${expected}`)
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(`Failed to open debug history: ${expected}`)
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it.each([
			["空文字", ""],
			["'..'", ".."],
			["パス区切りを含む", "a/../../../../etc"],
			["Windows セパレータ", "a\\..\\..\\etc"],
			["NUL を含む", "a\0b"],
		])(
			"【不変条件】タスク ID が %s なら getTaskDirectoryPath のガードで止まり、一時ファイルは作られない",
			async (_label, taskId) => {
				// このハンドラ自身はタスク ID を検査しない。storage 側の isSafeTaskId が唯一の防波堤。
				const h = makeProvider({ task: { taskId } })

				await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

				expect(writeFileMock).not.toHaveBeenCalled()
				expect(readFileMock).not.toHaveBeenCalled()
				expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
					expect.stringContaining("Failed to open debug history"),
				)
			},
		)

		it("【バグ／防御の欠如】storage 側のガードが外れると一時ファイルが tmpdir の外へ出る", async () => {
			// 一時ファイル名は `roo-debug-<api|ui>-${taskId.slice(0, 8)}-...` を
			// path.join(os.tmpdir(), ...) にそのまま渡している。taskId 側にセパレータや ".." が
			// 残っていると os.tmpdir() の外へ抜ける。現状は utils/storage の isSafeTaskId が
			// 先に throw することで偶然守られているだけで、fileEditorMessageHandlers.ts:86-91 に
			// 自前のガードは無い。slice の結果を basename 相当に落とすべき。
			const unsafeTaskId = "a/../../../../../../etc/evil"
			getTaskDirectoryPathMock.mockImplementation(async (...args: unknown[]) =>
				// ガードを外した素朴な実装。
				path.join(args[0] as string, "tasks", args[1] as string),
			)
			const h = makeProvider({ task: { taskId: unsafeTaskId } })
			readFileMock.mockResolvedValue("{}")

			await handler("openDebugApiHistory")(h.provider, msg({ type: "openDebugApiHistory" }))

			expect(writeFilePaths()).toHaveLength(1)
			const written = path.resolve(writeFilePaths()[0]!)
			// 現状の挙動を固定する。ガードが入ったらこの expect が落ちて気づける。
			expect(written.startsWith(path.resolve(TMP_DIR) + path.sep)).toBe(false)
			expect(() => expectAllPathsDirectlyUnder(writeFilePaths(), TMP_DIR)).toThrow()
		})
	})

	describe("downloadErrorDiagnostics", () => {
		it("実行中タスクが無ければ生成しない", async () => {
			const h = makeProvider()

			await handler("downloadErrorDiagnostics")(h.provider, msg({ type: "downloadErrorDiagnostics" }))

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("No active task to generate diagnostics for")
			expect(generateErrorDiagnosticsMock).not.toHaveBeenCalled()
		})

		it("タスク ID・globalStorage・values を渡し、log は provider へ転送する", async () => {
			const h = makeProvider({ task: { taskId: "task-1" } })

			await handler("downloadErrorDiagnostics")(
				h.provider,
				msg({ type: "downloadErrorDiagnostics", values: { includeApiHistory: true } }),
			)

			expect(generateErrorDiagnosticsMock).toHaveBeenCalledExactlyOnceWith({
				taskId: "task-1",
				globalStoragePath: GLOBAL_STORAGE_DIR,
				values: { includeApiHistory: true },
				log: expect.any(Function),
			})

			// 渡した log がそのまま provider.log を呼ぶ（診断の出力が消えない）。
			const passed = generateErrorDiagnosticsMock.mock.calls[0]![0] as { log: (m: string) => void }
			passed.log("diagnostics line")
			expect(h.log).toHaveBeenCalledExactlyOnceWith("diagnostics line")
		})
	})
})
