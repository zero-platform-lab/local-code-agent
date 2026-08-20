// npx vitest run api/providers/__tests__/fake-ai.spec.ts
//
// FakeAIHandler は「ネットワークに出ない」内部テスト用プロバイダ。VSCode global
// state 経由で複製された設定から、同一 ID の元インスタンスを引き直す薄いラッパ。
// ここでは委譲・キャッシュ・未設定時の throw を実測する。

import type { ModelInfo, AgentMessage, ContentBlockParam } from "@openai-agent/types"

import { FakeAIHandler } from "../fake-ai"
import type { ApiHandlerCreateMessageMetadata } from "../../types"
import type { ApiStream } from "../../transform/stream"

interface FakeAI {
	readonly id: string
	removeFromCache?: () => void
	createMessage(systemPrompt: string, messages: AgentMessage[], metadata?: ApiHandlerCreateMessageMetadata): ApiStream
	getModel(): { id: string; info: ModelInfo }
	countTokens(content: Array<ContentBlockParam>): Promise<number>
	completePrompt(prompt: string): Promise<string>
}

function makeFakeAi(id: string) {
	const createMessage = vi.fn(async function* (): ApiStream {
		yield { type: "text", text: "faked" }
	})
	const getModel = vi.fn(() => ({
		id: "fake-model",
		info: { contextWindow: 8, supportsPromptCache: false } as ModelInfo,
	}))
	const countTokens = vi.fn(async () => 7)
	const completePrompt = vi.fn(async () => "completed")
	const ai: FakeAI = { id, createMessage, getModel, countTokens, completePrompt }
	return { ai, createMessage, getModel, countTokens, completePrompt }
}

describe("FakeAIHandler", () => {
	it("throws when no fakeAi is provided", () => {
		expect(() => new FakeAIHandler({} as never)).toThrow("Fake AI is not set")
	})

	it("caches the fakeAi by id and installs removeFromCache on first use", () => {
		const { ai } = makeFakeAi("id-cache-1")
		expect(ai.removeFromCache).toBeUndefined()

		new FakeAIHandler({ fakeAi: ai } as never)

		// 初回はキャッシュへ登録し、削除用フックが差し込まれる。
		expect(typeof ai.removeFromCache).toBe("function")
	})

	it("reuses the cached instance for a fresh options object with the same id", () => {
		const first = makeFakeAi("id-shared")
		new FakeAIHandler({ fakeAi: first.ai } as never)

		// 設定は複製されて別オブジェクトになるが id は同じ。元インスタンスを引き直す。
		const secondOptionsObject = makeFakeAi("id-shared")
		const handler2 = new FakeAIHandler({ fakeAi: secondOptionsObject.ai } as never)

		// 2 つ目のオブジェクトの getModel は呼ばれず、最初にキャッシュした方が使われる。
		handler2.getModel()
		expect(first.getModel).toHaveBeenCalledTimes(1)
		expect(secondOptionsObject.getModel).not.toHaveBeenCalled()
	})

	it("delegates createMessage / getModel / countTokens / completePrompt to the fakeAi", async () => {
		const { ai, createMessage, getModel, countTokens, completePrompt } = makeFakeAi("id-delegate")
		const handler = new FakeAIHandler({ fakeAi: ai } as never)

		const messages: AgentMessage[] = [{ type: "message", role: "user", content: "hi" }]
		const metadata = { taskId: "t1" } as ApiHandlerCreateMessageMetadata
		const chunks: unknown[] = []
		for await (const chunk of handler.createMessage("sys", messages, metadata)) {
			chunks.push(chunk)
		}
		expect(chunks).toEqual([{ type: "text", text: "faked" }])
		expect(createMessage).toHaveBeenCalledWith("sys", messages, metadata)

		expect(handler.getModel().id).toBe("fake-model")
		expect(getModel).toHaveBeenCalled()

		const content: ContentBlockParam[] = [{ type: "text", text: "x" }]
		await expect(handler.countTokens(content)).resolves.toBe(7)
		expect(countTokens).toHaveBeenCalledWith(content)

		await expect(handler.completePrompt("prompt")).resolves.toBe("completed")
		expect(completePrompt).toHaveBeenCalledWith("prompt")
	})

	it("removeFromCache evicts the instance so a later construction re-registers", () => {
		const first = makeFakeAi("id-evict")
		new FakeAIHandler({ fakeAi: first.ai } as never)
		// キャッシュから明示的に削除する。
		first.ai.removeFromCache?.()

		const again = makeFakeAi("id-evict")
		const handler = new FakeAIHandler({ fakeAi: again.ai } as never)
		handler.getModel()
		// 削除後は新しいオブジェクトがキャッシュされ、そちらが使われる。
		expect(again.getModel).toHaveBeenCalledTimes(1)
		expect(first.getModel).not.toHaveBeenCalled()
	})
})
