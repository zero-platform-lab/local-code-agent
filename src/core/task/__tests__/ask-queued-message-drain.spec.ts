import type { ToolUse } from "../../../shared/tools"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task } from "../Task"
import { AskState } from "../AskState"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	it("consumes queued message while blocked on followup ask", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).toolRepetitionDetector = new ToolRepetitionDetector(3)
		;(task as any).messageStore = { clineMessages: [], apiConversationHistory: [] }
		;(task as any).askState = new AskState()

		// Message queue service exists in constructor; for unit test we can attach a real one.
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()

		// Minimal stubs used by ask()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("followup", "Q?", false)

		// Simulate webview queuing the user's selection text while the ask is pending.
		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).messageStore = { clineMessages: [], apiConversationHistory: [] }
		;(task as any).askState = new AskState()

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})
})

// 繰り返しの判定の回数は、人が応答したら 0 に戻り、自動で応答したら残る。
// 同じ ask を、人の応答と自動拒否のそれぞれで終わらせて、前後をまたいで確かめる。
describe("Task.ask の応答と繰り返しの判定", () => {
	const tool: ToolUse = {
		type: "tool_use",
		name: "execute_command",
		params: { command: "npm test" },
		partial: false,
	}

	async function makeTask() {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).toolRepetitionDetector = new ToolRepetitionDetector(3)
		;(task as any).messageStore = { clineMessages: [], apiConversationHistory: [] }
		;(task as any).askState = new AskState()
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		// 同じ呼び出しを 3 回通す。次の 4 回目が上限に当たる
		for (let i = 0; i < 3; i++) {
			expect(task.toolRepetitionDetector.check(tool).allowExecution).toBe(true)
		}
		return task
	}

	it("人の応答（キューのメッセージ）を受けたら、次の同じ呼び出しを通す", async () => {
		const task = await makeTask()

		const askPromise = task.ask("tool", "run npm test?", false)
		;(task as any).messageQueueService.addMessage("もう一回")
		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(task.toolRepetitionDetector.check(tool).allowExecution).toBe(true)
	})

	it("自動拒否（denyAsk）で終わったら回数を残し、次の同じ呼び出しを止める", async () => {
		const task = await makeTask()

		const askPromise = task.ask("tool", "run npm test?", false)
		setTimeout(() => task.denyAsk(), 0)
		const result = await askPromise

		expect(result.response).toBe("noButtonClicked")
		expect(task.toolRepetitionDetector.check(tool).allowExecution).toBe(false)
	})

	it("画面からの応答（handleUserAskResponse）でも、次の同じ呼び出しを通す", async () => {
		const task = await makeTask()

		const askPromise = task.ask("tool", "run npm test?", false)
		setTimeout(() => task.handleUserAskResponse("noButtonClicked"), 0)
		await askPromise

		expect(task.toolRepetitionDetector.check(tool).allowExecution).toBe(true)
	})
})
