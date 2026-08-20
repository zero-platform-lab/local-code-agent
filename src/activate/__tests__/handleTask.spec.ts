// npx vitest run activate/__tests__/handleTask.spec.ts
//
// handleNewTask は「新規タスク」コマンドの実体。不変条件として固定するのは:
//   1. params.prompt があればそのまま採用し、入力ボックスは出さない
//   2. prompt が無ければ入力ボックスを出し、得た値でタスクを起こす
//   3. どうしても prompt が空なら（キャンセル含む）タスクは起こさず、
//      サイドバーへフォーカスを戻すだけで落ちない

import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
	showInputBox: vi.fn(async (..._args: unknown[]) => undefined as unknown as string | undefined),
	executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
	handleCodeAction: vi.fn(async (..._args: unknown[]) => undefined),
	t: vi.fn((key: string) => key),
}))

vi.mock("vscode", () => ({
	window: { showInputBox: mocks.showInputBox },
	commands: { executeCommand: mocks.executeCommand },
}))

vi.mock("../../shared/package", () => ({ Package: { name: "openai-agent" } }))

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { handleCodeAction: mocks.handleCodeAction },
}))

vi.mock("../../i18n", () => ({ t: mocks.t }))

import { handleNewTask } from "../handleTask"

beforeEach(() => {
	vi.clearAllMocks()
	mocks.showInputBox.mockResolvedValue(undefined)
})

describe("handleNewTask", () => {
	it("params.prompt があれば入力ボックスを出さずそのまま起票する", async () => {
		await handleNewTask({ prompt: "ここに書いたやつ" })

		expect(mocks.showInputBox).not.toHaveBeenCalled()
		expect(mocks.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", {
			userInput: "ここに書いたやつ",
		})
		expect(mocks.executeCommand).not.toHaveBeenCalled()
	})

	it("prompt が無ければ入力ボックスを出し、その値で起票する", async () => {
		mocks.showInputBox.mockResolvedValue("入力された指示")

		await handleNewTask(null)

		expect(mocks.showInputBox).toHaveBeenCalledWith({
			prompt: "common:input.task_prompt",
			placeHolder: "common:input.task_placeholder",
		})
		expect(mocks.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", {
			userInput: "入力された指示",
		})
	})

	it("params が undefined でも落ちず、入力ボックス経由になる", async () => {
		mocks.showInputBox.mockResolvedValue("x")

		await handleNewTask(undefined)

		expect(mocks.showInputBox).toHaveBeenCalledTimes(1)
		expect(mocks.handleCodeAction).toHaveBeenCalledTimes(1)
	})

	it("入力ボックスがキャンセル（空）ならタスクは起こさずサイドバーへフォーカスする", async () => {
		mocks.showInputBox.mockResolvedValue(undefined)

		await handleNewTask({ prompt: "" })

		expect(mocks.executeCommand).toHaveBeenCalledWith("openai-agent.SidebarProvider.focus")
		expect(mocks.handleCodeAction).not.toHaveBeenCalled()
	})
})
