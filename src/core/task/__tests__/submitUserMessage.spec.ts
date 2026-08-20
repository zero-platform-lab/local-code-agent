import { describe, it, expect, vi, afterEach } from "vitest"

import { AgentEventName, type ProviderSettings } from "@openai-agent/types"

import {
	submitUserMessage,
	type SubmitUserMessageProvider,
	type SubmitUserMessageStateHost,
} from "../submitUserMessage"

function makeProvider(overrides: Partial<SubmitUserMessageProvider> = {}): SubmitUserMessageProvider {
	return {
		setMode: vi.fn((..._a: unknown[]) => Promise.resolve()),
		setProviderProfile: vi.fn((..._a: unknown[]) => Promise.resolve()),
		getState: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
		...overrides,
	}
}

function makeHost(provider: SubmitUserMessageProvider | undefined) {
	const emit = vi.fn()
	const updateApiConfiguration = vi.fn()
	const handleWebviewAskResponse = vi.fn()
	const host: SubmitUserMessageStateHost = {
		taskId: "task-123",
		emit,
		updateApiConfiguration,
		handleWebviewAskResponse,
		providerRef: { deref: () => provider } as unknown as WeakRef<SubmitUserMessageProvider>,
	}
	return { host, emit, updateApiConfiguration, handleWebviewAskResponse }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("submitUserMessage", () => {
	it("text も images も空なら早期リターンし、provider 解決も emit も ask ハンドラ呼び出しも行わない", async () => {
		const provider = makeProvider()
		const { host, emit, handleWebviewAskResponse } = makeHost(provider)

		await submitUserMessage({ host }, undefined as unknown as string, undefined)

		expect(emit).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(provider.setMode).not.toHaveBeenCalled()
	})

	it("text のみ（mode / profile 無し）なら前後をトリムし、emit 後に messageResponse として ask ハンドラへ渡す", async () => {
		const provider = makeProvider()
		const { host, emit, updateApiConfiguration, handleWebviewAskResponse } = makeHost(provider)

		await submitUserMessage({ host }, "  hi  ")

		expect(provider.setMode).not.toHaveBeenCalled()
		expect(provider.setProviderProfile).not.toHaveBeenCalled()
		expect(updateApiConfiguration).not.toHaveBeenCalled()
		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskUserMessage, "task-123")
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", [])
	})

	it("text が空でも images があれば続行し、mode / profile を切替え、profile 更新後の apiConfiguration を反映する", async () => {
		const config = { apiProvider: "openai" } as unknown as ProviderSettings
		const provider = makeProvider({
			getState: vi.fn((..._a: unknown[]) => Promise.resolve({ apiConfiguration: config })),
		})
		const { host, emit, updateApiConfiguration, handleWebviewAskResponse } = makeHost(provider)

		await submitUserMessage({ host }, "", ["img"], "architect", "prof-a")

		expect(provider.setMode).toHaveBeenCalledWith("architect")
		expect(provider.setProviderProfile).toHaveBeenCalledWith("prof-a")
		expect(provider.getState).toHaveBeenCalledTimes(1)
		expect(updateApiConfiguration).toHaveBeenCalledWith(config)
		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskUserMessage, "task-123")
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "", ["img"])
	})

	it("profile 切替後の getState が undefined なら apiConfiguration は反映しない", async () => {
		const provider = makeProvider({
			getState: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
		})
		const { host, updateApiConfiguration, handleWebviewAskResponse } = makeHost(provider)

		await submitUserMessage({ host }, "hi", undefined, undefined, "prof-b")

		expect(provider.setProviderProfile).toHaveBeenCalledWith("prof-b")
		expect(updateApiConfiguration).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", [])
	})

	it("profile 切替後の getState に apiConfiguration が無ければ反映しない", async () => {
		const provider = makeProvider({
			getState: vi.fn((..._a: unknown[]) => Promise.resolve({})),
		})
		const { host, updateApiConfiguration } = makeHost(provider)

		await submitUserMessage({ host }, "hi", [], undefined, "prof-c")

		expect(updateApiConfiguration).not.toHaveBeenCalled()
	})

	it("provider 参照が失われていれば error ログを出し、以降の副作用（emit / ask ハンドラ）を行わない", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { host, emit, handleWebviewAskResponse } = makeHost(undefined)

		await submitUserMessage({ host }, "hi")

		expect(errorSpy).toHaveBeenCalledWith("[Task#submitUserMessage] Provider reference lost")
		expect(emit).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("処理中に例外が出ても throw せず error ログに落とし、ask ハンドラは呼ばない", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const boom = new Error("mode boom")
		const provider = makeProvider({
			setMode: vi.fn((..._a: unknown[]) => Promise.reject(boom)),
		})
		const { host, emit, handleWebviewAskResponse } = makeHost(provider)

		await submitUserMessage({ host }, "hi", [], "architect")

		expect(errorSpy).toHaveBeenCalledWith("[Task#submitUserMessage] Failed to submit user message:", boom)
		expect(emit).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})
})
