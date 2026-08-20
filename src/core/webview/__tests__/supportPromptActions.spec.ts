// npx vitest run src/core/webview/__tests__/supportPromptActions.spec.ts
//
// supportPromptActions は「エディタ／ターミナルのコンテキストメニュー操作」を
// 実際のタスク起動に変換する層。ここで固定したい不変条件は 3 つ。
//
//   1. addToContext 系（addToContext / terminalAddToContext）は **タスクを起動しない**。
//      チャット欄に文字列を差し込むだけの操作なので、ここで createTask が走ると
//      ユーザーが意図しないまま API リクエストが始まってしまう。
//   2. それ以外のコマンドは必ず createTask に到達し、postMessageToWebview を使わない。
//   3. allowlist 違反（OrganizationAllowListViolationError）はダイアログを出しつつ
//      **握り潰さずに再 throw** する（呼び出し規約）。それ以外の例外はダイアログ無しで再 throw。
//
// supportPrompt / createPrompt は純粋関数なのでモックせず本物を使う。
// テンプレート差し替え（customSupportPrompts）も本物の経路で確認する。

import type {
	CodeActionId,
	CodeActionName,
	ExtensionMessage,
	TerminalActionId,
	TerminalActionPromptType,
} from "@openai-agent/types"

// vscode は showErrorMessage の呼ばれ方だけ見たいので最小限に差し替える。
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

import * as vscode from "vscode"

import { OrganizationAllowListViolationError } from "../../../utils/errors"
import { runCodeAction, runTerminalAction, type SupportPromptActionTarget } from "../supportPromptActions"

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

interface SetupOptions {
	/** getState() が返す customSupportPrompts。undefined なら既定テンプレート。 */
	customSupportPrompts?: Record<string, string>
	/** getState() 自体の戻り値を丸ごと差し替える（キーごと欠落させる用）。 */
	state?: { customSupportPrompts?: Record<string, string> }
	/** createTask の実装（例外を投げさせる用）。 */
	createTask?: (prompt: string) => Promise<unknown>
}

function setup(options: SetupOptions = {}) {
	const state = options.state ?? { customSupportPrompts: options.customSupportPrompts }

	const getState = vi.fn(async () => state)
	const postMessageToWebview = vi.fn(async (_message: ExtensionMessage) => {})
	const createTask = vi.fn(options.createTask ?? (async (_prompt: string) => ({ taskId: "t1" })))

	const target: SupportPromptActionTarget = { getState, postMessageToWebview, createTask }

	return {
		target,
		getState,
		postMessageToWebview,
		createTask,
		/** createTask に渡ったプロンプト文字列（全件）。 */
		prompts: () => createTask.mock.calls.map((call) => call[0] as string),
		/** postMessageToWebview に渡ったメッセージ（全件）。 */
		posted: () => postMessageToWebview.mock.calls.map((call) => call[0]),
	}
}

const SELECTION_PARAMS = {
	filePath: "src/a.ts",
	startLine: "10",
	endLine: "20",
	selectedText: "const x = 1",
	userInput: "ここを直して",
}

const TERMINAL_PARAMS = {
	terminalContent: "npm run build\nError: boom",
	userInput: "直して",
}

beforeEach(() => {
	vi.clearAllMocks()
})

// ---------------------------------------------------------------------------

describe("runCodeAction", () => {
	describe("不変条件1: addToContext はタスクを起動しない", () => {
		it("addToContext はチャット欄への差し込みとフォーカスだけを行い createTask を呼ばない", async () => {
			const h = setup()

			await runCodeAction(h.target, "addToContext", "ADD_TO_CONTEXT", SELECTION_PARAMS)

			// ここが崩れると「選択範囲をコンテキストに追加」しただけで API リクエストが走る。
			expect(h.createTask).not.toHaveBeenCalled()

			const posted = h.posted()
			expect(posted).toHaveLength(2)
			expect(posted[0]).toMatchObject({ type: "invoke", invoke: "setChatBoxMessage" })
			// 末尾に空行 2 つ。既存メッセージへの追記時に行が繋がらないようにするための規約。
			expect((posted[0] as { text: string }).text).toBe("src/a.ts:10-20\n```\nconst x = 1\n```\n\n")
			expect((posted[0] as { text: string }).text.endsWith("\n\n")).toBe(true)
			expect(posted[1]).toEqual({ type: "action", action: "focusInput" })
		})

		it("addToContext では promptType が ADD_TO_CONTEXT 以外でもタスクは起動しない（分岐は command のみで決まる）", async () => {
			// 実装は promptType ではなく command === "addToContext" だけを見る。
			const h = setup()

			await runCodeAction(h.target, "addToContext", "EXPLAIN", SELECTION_PARAMS)

			expect(h.createTask).not.toHaveBeenCalled()
			expect(h.posted()).toHaveLength(2)
			// EXPLAIN テンプレートが使われている＝promptType 側は素通ししている。
			expect((h.posted()[0] as { text: string }).text).toContain("Explain the following code")
		})
	})

	describe("不変条件2: addToContext 以外は createTask に到達する", () => {
		const cases: Array<{ command: CodeActionId; promptType: CodeActionName; contains: string }> = [
			{ command: "explainCode", promptType: "EXPLAIN", contains: "Explain the following code" },
			{ command: "fixCode", promptType: "FIX", contains: "Fix any issues in the following code" },
			{ command: "improveCode", promptType: "IMPROVE", contains: "Improve the following code" },
			{ command: "newTask", promptType: "NEW_TASK", contains: "ここを直して" },
		]

		it.each(cases)(
			"$command はプロンプトを組み立てて createTask を 1 回だけ呼ぶ",
			async ({ command, promptType, contains }) => {
				const h = setup()

				await runCodeAction(h.target, command, promptType, SELECTION_PARAMS)

				expect(h.createTask).toHaveBeenCalledOnce()
				expect(h.prompts()[0]).toContain(contains)
				// webview への直接差し込みは行わない。
				expect(h.postMessageToWebview).not.toHaveBeenCalled()
				expect(h.getState).toHaveBeenCalledOnce()
			},
		)

		it("パラメータはテンプレートに展開され、未知のプレースホルダは空文字になる", async () => {
			const h = setup()

			await runCodeAction(h.target, "explainCode", "EXPLAIN", {
				filePath: "src/b.ts",
				startLine: "1",
				endLine: "2",
				selectedText: "let y",
				// userInput を渡さない → `${userInput}` は空文字に置換される。
			})

			const prompt = h.prompts()[0]
			expect(prompt).toContain("src/b.ts:1-2")
			expect(prompt).toContain("let y")
			expect(prompt).not.toContain("${userInput}")
		})
	})

	describe("customSupportPrompts（テンプレート差し替え）", () => {
		it("カスタムテンプレートがあればそちらが使われる", async () => {
			const h = setup({ customSupportPrompts: { EXPLAIN: "CUSTOM ${selectedText}" } })

			await runCodeAction(h.target, "explainCode", "EXPLAIN", SELECTION_PARAMS)

			expect(h.prompts()).toEqual(["CUSTOM const x = 1"])
		})

		it("別種別のカスタムテンプレートしか無ければ既定テンプレートに落ちる", async () => {
			const h = setup({ customSupportPrompts: { FIX: "CUSTOM FIX" } })

			await runCodeAction(h.target, "explainCode", "EXPLAIN", SELECTION_PARAMS)

			expect(h.prompts()[0]).toContain("Explain the following code")
		})

		it("getState が customSupportPrompts キーを持たなくても既定テンプレートで動く", async () => {
			// 設定が未初期化のタイミングで実際に起きる形。
			const h = setup({ state: {} })

			await runCodeAction(h.target, "explainCode", "EXPLAIN", SELECTION_PARAMS)

			expect(h.prompts()[0]).toContain("Explain the following code")
		})
	})

	describe("未知の command", () => {
		it("【要確認】未知の command は無視されず createTask に落ちる", async () => {
			// 実装は command === "addToContext" 以外をすべて「タスク起動」として扱うため、
			// webview から壊れた command が来た場合も黙ってタスクが起動する。
			// 「未知なら何もしない」ではないことを明示的に固定しておく。
			const h = setup()

			await runCodeAction(h.target, "totallyUnknownCommand" as CodeActionId, "EXPLAIN", SELECTION_PARAMS)

			expect(h.createTask).toHaveBeenCalledOnce()
		})

		it("createTask が投げた例外はそのまま伝播する（runCodeAction 側に catch は無い）", async () => {
			const h = setup({
				createTask: async () => {
					throw new Error("create failed")
				},
			})

			await expect(runCodeAction(h.target, "explainCode", "EXPLAIN", SELECTION_PARAMS)).rejects.toThrow(
				"create failed",
			)
			// コードアクション側では allowlist 違反のダイアログは出さない（ターミナル側だけの処理）。
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})
	})
})

describe("runTerminalAction", () => {
	describe("不変条件1: terminalAddToContext はタスクを起動しない", () => {
		it("terminalAddToContext は差し込み 2 通のみで createTask を呼ばない", async () => {
			const h = setup()

			await runTerminalAction(h.target, "terminalAddToContext", "TERMINAL_ADD_TO_CONTEXT", TERMINAL_PARAMS)

			expect(h.createTask).not.toHaveBeenCalled()
			const posted = h.posted()
			expect(posted).toHaveLength(2)
			expect(posted[0]).toMatchObject({ type: "invoke", invoke: "setChatBoxMessage" })
			expect((posted[0] as { text: string }).text).toContain("npm run build")
			expect((posted[0] as { text: string }).text.endsWith("\n\n")).toBe(true)
			expect(posted[1]).toEqual({ type: "action", action: "focusInput" })
		})

		it("terminalAddToContext は createTask が壊れていても影響を受けない（到達しない）", async () => {
			const h = setup({
				createTask: async () => {
					throw new OrganizationAllowListViolationError("blocked")
				},
			})

			await expect(
				runTerminalAction(h.target, "terminalAddToContext", "TERMINAL_ADD_TO_CONTEXT", TERMINAL_PARAMS),
			).resolves.toBeUndefined()

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})
	})

	describe("不変条件2: それ以外は createTask に到達する", () => {
		const cases: Array<{ command: TerminalActionId; promptType: TerminalActionPromptType; contains: string }> = [
			{ command: "terminalFixCommand", promptType: "TERMINAL_FIX", contains: "Fix this terminal command" },
			{
				command: "terminalExplainCommand",
				promptType: "TERMINAL_EXPLAIN",
				contains: "Explain this terminal command",
			},
		]

		it.each(cases)("$command は createTask を 1 回だけ呼ぶ", async ({ command, promptType, contains }) => {
			const h = setup()

			await runTerminalAction(h.target, command, promptType, TERMINAL_PARAMS)

			expect(h.createTask).toHaveBeenCalledOnce()
			expect(h.prompts()[0]).toContain(contains)
			expect(h.prompts()[0]).toContain("npm run build")
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("カスタムテンプレートはターミナル側でも効く", async () => {
			const h = setup({ customSupportPrompts: { TERMINAL_FIX: "FIX> ${terminalContent}" } })

			await runTerminalAction(h.target, "terminalFixCommand", "TERMINAL_FIX", TERMINAL_PARAMS)

			expect(h.prompts()).toEqual(["FIX> npm run build\nError: boom"])
		})
	})

	describe("不変条件3: allowlist 違反はダイアログを出しつつ再 throw", () => {
		it("OrganizationAllowListViolationError はダイアログを出してから再 throw する", async () => {
			const h = setup({
				createTask: async () => {
					throw new OrganizationAllowListViolationError("この API 設定は組織で許可されていません")
				},
			})

			await expect(
				runTerminalAction(h.target, "terminalFixCommand", "TERMINAL_FIX", TERMINAL_PARAMS),
			).rejects.toBeInstanceOf(OrganizationAllowListViolationError)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
				"この API 設定は組織で許可されていません",
			)
		})

		it("それ以外の Error はダイアログ無しで再 throw する", async () => {
			const h = setup({
				createTask: async () => {
					throw new Error("network down")
				},
			})

			await expect(
				runTerminalAction(h.target, "terminalExplainCommand", "TERMINAL_EXPLAIN", TERMINAL_PARAMS),
			).rejects.toThrow("network down")

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("Error でない値が投げられてもダイアログ無しでそのまま再 throw する", async () => {
			const h = setup({
				createTask: async () => {
					throw "not-an-error"
				},
			})

			await expect(
				runTerminalAction(h.target, "terminalFixCommand", "TERMINAL_FIX", TERMINAL_PARAMS),
			).rejects.toBe("not-an-error")

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})
	})

	describe("未知の command", () => {
		it("【要確認】未知の command は無視されず createTask に落ちる", async () => {
			const h = setup()

			await runTerminalAction(
				h.target,
				"totallyUnknownTerminalCommand" as TerminalActionId,
				"TERMINAL_FIX",
				TERMINAL_PARAMS,
			)

			expect(h.createTask).toHaveBeenCalledOnce()
		})
	})
})
