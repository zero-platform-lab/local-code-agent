// npx vitest run api/providers/__tests__/openai.spec.ts

import { OpenAiHandler, getOpenAiModels } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"
import OpenAI from "openai"
import { Package } from "../../../shared/package"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"
// axios は実装から外れたため import 不要。テストは globalThis.fetch を差し替える。

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	const mockConstructor = vitest.fn()
	return {
		__esModule: true,
		default: mockConstructor.mockImplementation(() => ({
			chat: {
				completions: {
					create: mockCreate.mockImplementation(async (options) => {
						if (!options.stream) {
							return {
								id: "test-completion",
								choices: [
									{
										message: {
											type: "message" as const,
											role: "assistant",
											content: "Test response",
											refusal: null,
										},
										finish_reason: "stop",
										index: 0,
									},
								],
								usage: {
									prompt_tokens: 10,
									completion_tokens: 5,
									total_tokens: 15,
								},
							}
						}

						return {
							[Symbol.asyncIterator]: async function* () {
								yield {
									choices: [
										{
											delta: { content: "Test response" },
											index: 0,
										},
									],
									usage: null,
								}
								yield {
									choices: [
										{
											delta: {},
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
									},
								}
							},
						}
					}),
				},
			},
		})),
	}
})

// getOpenAiModels は built-in fetch を使うので、テストでは差し替える。
const originalFetch = globalThis.fetch
const mockedFetch = vitest.fn()
beforeAll(() => {
	globalThis.fetch = mockedFetch as unknown as typeof fetch
})
afterAll(() => {
	globalThis.fetch = originalFetch
})
beforeEach(() => {
	mockedFetch.mockReset()
})
function fetchOk(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as unknown as Response
}

describe("OpenAiHandler", () => {
	let handler: OpenAiHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		}
		handler = new OpenAiHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(OpenAiHandler)
			expect(handler.getModel().id).toBe(mockOptions.openAiModelId)
		})

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.openai.com/v1"
			const handlerWithCustomUrl = new OpenAiHandler({
				...mockOptions,
				openAiBaseUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(OpenAiHandler)
		})

		it("should set default headers correctly", () => {
			// Check that the OpenAI constructor was called with correct parameters
			expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({
				baseURL: expect.any(String),
				apiKey: expect.any(String),
				defaultHeaders: {
					"User-Agent": `OpenAIAgent/${Package.version}`,
				},
				timeout: expect.any(Number),
			})
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: any[] = [
			{
				type: "message" as const,
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("should handle non-streaming mode", async () => {
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)
		})

		it("should handle tool calls in non-streaming mode", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							type: "message" as const,
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: '{"arg":"value"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: '{"arg":"value"}',
			})
		})

		it("should handle streaming responses", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should handle tool calls in streaming responses", async () => {
			mockCreate.mockImplementation(async (_options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "test_tool", arguments: "" },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '{"arg":' } }],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '"value"}' } }],
									},
									finish_reason: "tool_calls",
								},
							],
						}
					},
				}
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(3)
			// First chunk has id and name
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			// Subsequent chunks have arguments
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '{"arg":',
			})
			expect(toolCallPartialChunks[2]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '"value"}',
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("should yield tool calls even when finish_reason is not set (fallback behavior)", async () => {
			mockCreate.mockImplementation(async (_options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_fallback",
												function: { name: "fallback_tool", arguments: '{"test":"fallback"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						// Stream ends without finish_reason being set to "tool_calls"
						yield {
							choices: [
								{
									delta: {},
									finish_reason: "stop", // Different finish reason
								},
							],
						}
					},
				}
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_fallback",
				name: "fallback_tool",
				arguments: '{"test":"fallback"}',
			})
		})

		it("should include reasoning_effort when reasoning effort is enabled", async () => {
			const reasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsReasoningEffort: true,
					reasoningEffort: "high",
				},
			}
			const reasoningHandler = new OpenAiHandler(reasoningOptions)
			const stream = reasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called with reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBe("high")
		})

		it("should not include reasoning_effort when reasoning effort is disabled", async () => {
			const noReasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: false,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
			}
			const noReasoningHandler = new OpenAiHandler(noReasoningOptions)
			const stream = noReasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called without reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("should include max_tokens when includeMaxTokens is true", async () => {
			const optionsWithMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithMaxTokens = new OpenAiHandler(optionsWithMaxTokens)
			const stream = handlerWithMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called with max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})

		it("should not include max_tokens when includeMaxTokens is false", async () => {
			const optionsWithoutMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: false,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithoutMaxTokens = new OpenAiHandler(optionsWithoutMaxTokens)
			const stream = handlerWithoutMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called without max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it("should not include max_tokens when includeMaxTokens is undefined", async () => {
			const optionsWithUndefinedMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				// includeMaxTokens is not set, should not include max_tokens
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithDefaultMaxTokens = new OpenAiHandler(optionsWithUndefinedMaxTokens)
			const stream = handlerWithDefaultMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called without max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it("should use model maxTokens for max_completion_tokens", async () => {
			const optionsWithoutUserMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096, // Model's default value (should be used as fallback)
					supportsPromptCache: false,
				},
			}
			const handlerWithoutUserMaxTokens = new OpenAiHandler(optionsWithoutUserMaxTokens)
			const stream = handlerWithoutUserMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			for await (const _chunk of stream) {
				// ストリームを最後まで消費するのが目的（中身は使わない）
			}
			// Assert the mockCreate was called with model default maxTokens (4096) as fallback
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})

		it("should NOT include max_tokens when includeMaxTokens is true but maxTokens is non-positive (sane default -1)", async () => {
			// openAiModelInfoSaneDefaults の maxTokens 既定は -1。includeMaxTokens=true でも
			// -1 を max_completion_tokens として送ると 400 になるため、送らないこと。
			const optionsWithNegativeMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: -1,
					supportsPromptCache: false,
				},
			}
			const handler = new OpenAiHandler(optionsWithNegativeMaxTokens)
			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// consume
			}
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it("should NOT include max_tokens when includeMaxTokens is true but maxTokens is null (nullish)", async () => {
			// ModelInfo.maxTokens は number | null | undefined。null のとき typeof ガードで送らない。
			const optionsWithNullMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: null,
					supportsPromptCache: false,
				},
			}
			const handler = new OpenAiHandler(optionsWithNullMaxTokens)
			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// consume
			}
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})
	})

	describe("error handling", () => {
		const testMessages: any[] = [
			{
				type: "message" as const,
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello",
					},
				],
			},
		]

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("API Error")
		})

		it("should handle rate limiting", async () => {
			const rateLimitError = new Error("Rate limit exceeded")
			rateLimitError.name = "Error"
			;(rateLimitError as any).status = 429
			mockCreate.mockRejectedValueOnce(rateLimitError)

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("Rate limit exceeded")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{},
			)
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error: API Error")
		})

		it("should handle empty response", async () => {
			mockCreate.mockImplementationOnce(() => ({
				choices: [{ message: { content: "" } }],
			}))
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe("getModel", () => {
		it("should return model info with sane defaults", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.openAiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(128_000)
			expect(model.info.supportsImages).toBe(true)
		})

		it("should handle undefined model ID", () => {
			const handlerWithoutModel = new OpenAiHandler({
				...mockOptions,
				openAiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe("")
			expect(model.info).toBeDefined()
		})
	})

	describe("Azure AI Inference Service", () => {
		const azureOptions = {
			...mockOptions,
			openAiBaseUrl: "https://test.services.ai.azure.com",
			openAiModelId: "deepseek-v3",
			azureApiVersion: "2024-05-01-preview",
		}

		it("should initialize with Azure AI Inference Service configuration", () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			expect(azureHandler).toBeInstanceOf(OpenAiHandler)
			expect(azureHandler.getModel().id).toBe(azureOptions.openAiModelId)
		})

		it("should handle streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")

			// Verify the API call was made with correct Azure AI Inference Service path
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					// modelTemperature 未設定なので temperature は送らない（明示時のみ送る方針）。
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				expect.objectContaining({ path: "/models/chat/completions" }),
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle non-streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler({
				...azureOptions,
				openAiStreamingEnabled: false,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)

			// Verify the API call was made with correct Azure AI Inference Service path.
			// modelTemperature 未設定なので temperature は送らない（明示時のみ送る方針）。
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				expect.objectContaining({ path: "/models/chat/completions" }),
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle completePrompt with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const result = await azureHandler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})
	})

	describe("O3 Family Models", () => {
		const o3Options = {
			...mockOptions,
			openAiModelId: "o3-mini",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		}

		it("should handle O3 model with streaming and include max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: true,
				modelTemperature: 0.5,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 65536,
				}),
				{},
			)
		})

		it("emits reasoning from the O3 streaming path (both field names)", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { reasoning_content: "考A" }, finish_reason: null }] }
					yield { choices: [{ delta: { reasoning: "考B" }, finish_reason: null }] }
					// 推論を持たない delta は何も足さない。
					yield { choices: [{ delta: { content: "answer" }, finish_reason: null }] }
				},
			}))

			const chunks: any[] = []
			for await (const chunk of o3Handler.createMessage("system", [])) chunks.push(chunk)

			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([
				{ type: "reasoning", text: "考A" },
				{ type: "reasoning", text: "考B" },
			])
			expect(chunks.find((c) => c.type === "text")?.text).toBe("answer")
		})

		it("should handle tool calls with O3 model in streaming mode", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (_options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "test_tool", arguments: "" },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: "{}" } }],
									},
									finish_reason: "tool_calls",
								},
							],
						}
					},
				}
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(2)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: "{}",
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("should yield tool calls for O3 model even when finish_reason is not set (fallback behavior)", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (_options) => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_o3_fallback",
												function: { name: "o3_fallback_tool", arguments: '{"o3":"test"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						}
						// Stream ends with different finish reason
						yield {
							choices: [
								{
									delta: {},
									finish_reason: "length", // Different finish reason
								},
							],
						}
					},
				}
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_o3_fallback",
				name: "o3_fallback_tool",
				arguments: '{"o3":"test"}',
			})
		})

		it("should handle O3 model with streaming and exclude max_tokens when includeMaxTokens is false", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: false,
				modelTemperature: 0.7,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
				}),
				{},
			)

			// Verify max_tokens is NOT included
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle O3 model non-streaming with reasoning_effort and max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
				includeMaxTokens: true,
				modelTemperature: 0.3,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 65536, // Using default maxTokens from o3Options
				}),
				{},
			)

			// Verify stream is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stream")
		})

		it("should handle tool calls with O3 model in non-streaming mode", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
			})

			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							type: "message" as const,
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: "{}",
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: "{}",
			})
		})

		it("should use default temperature of 0 when not specified for O3 models", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				// No modelTemperature specified
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: undefined, // Temperature is not supported for O3 models
				}),
				{},
			)
		})

		it("should handle O3 model with Azure AI Inference Service respecting includeMaxTokens", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: false, // Should NOT include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
				}),
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is false
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should NOT include max_tokens for O3 model with Azure AI Inference Service even when includeMaxTokens is true", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: true, // Should include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: any[] = [
				{
					type: "message" as const,
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					// O3 models do not support max_tokens
				}),
				{ path: "/models/chat/completions" },
			)
		})
	})

	describe("coverage: chat completions branches", () => {
		const systemPrompt = "sys"
		const userMessages: any[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]

		function streamOf(chunks: any[]) {
			return {
				[Symbol.asyncIterator]: async function* () {
					for (const c of chunks) yield c
				},
			}
		}

		it("emits reasoning chunks from delta.reasoning_content (native reasoning field)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					{ choices: [{ delta: { reasoning_content: "step 1" }, index: 0 }] },
					// 空値は握り潰す（`&& delta.reasoning_content` の false 側）
					{ choices: [{ delta: { reasoning_content: "" }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
				]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "step 1" }])
			expect(chunks.find((c) => c.type === "text")?.text).toBe("answer")
		})

		it("emits reasoning chunks from delta.reasoning (Ollama の置き場所)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					// Ollama は reasoning_content ではなく reasoning に入れてくる。
					{ choices: [{ delta: { reasoning: "考え中" }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
				]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "考え中" }])
			expect(chunks.find((c) => c.type === "text")?.text).toBe("answer")
		})

		it("prefers reasoning_content when a server sends both", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: { reasoning_content: "正", reasoning: "副" }, index: 0 }] }]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "正" }])
		})

		it("ignores reasoning fields that are not usable text", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					{ choices: [{ delta: { reasoning: "" }, index: 0 }] },
					// 文字列以外を入れてくるサーバもありうる。型が違えば無視する。
					{ choices: [{ delta: { reasoning: { text: "obj" } }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
				]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([])
		})

		it("separates a complete <think>…</think> block into reasoning vs text", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: { content: "<think>why</think>done" }, index: 0 }] }]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.find((c) => c.type === "reasoning")?.text).toBe("why")
			expect(chunks.find((c) => c.type === "text")?.text).toBe("done")
		})

		it("flushes a dangling partial <think tag through matcher.final()", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: { content: "<think" }, index: 0 }] }]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			// 途中で切れたタグも取りこぼさず final() で吐き出す。
			expect(chunks.some((c) => c.type === "text" && c.text.includes("<think"))).toBe(true)
		})

		it("tolerates malformed streaming chunks with no choices/delta", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{}, { choices: [] }, { choices: [{ delta: { content: "ok" } }] }]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.find((c) => c.type === "text")?.text).toBe("ok")
		})

		it("uses an empty model id when none is configured", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)
			const handler = new OpenAiHandler({ ...mockOptions, openAiModelId: undefined })
			for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			expect(mockCreate.mock.calls.at(-1)![0].model).toBe("")
		})

		it("passes tools / tool_choice / parallelToolCalls=false through in streaming mode", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			const handler = new OpenAiHandler(mockOptions)
			const metadata: any = {
				taskId: "t",
				tools: [
					{
						type: "function",
						function: { name: "read", description: "d", parameters: { type: "object", properties: {} } },
					},
				],
				tool_choice: "auto",
				parallelToolCalls: false,
			}
			for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			const args = mockCreate.mock.calls.at(-1)![0]
			expect(args.tool_choice).toBe("auto")
			expect(args.parallel_tool_calls).toBe(false)
			expect(args.tools?.[0]?.function?.name).toBe("read")
		})

		it("sends reasoning_effort on the non-streaming path (GPT-5.6 の tools 400 回避)", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_000,
					supportsPromptCache: false,
					reasoningEffort: "none",
				},
			})
			const metadata: any = { tools: [{ type: "function", function: { name: "t", parameters: {} } }] }
			for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			expect(sent.reasoning_effort).toBe("none")
			// 非ストリーミングは temperature を送らない（reasoning モデルの制約とも整合）。
			expect("temperature" in sent).toBe(false)
		})

		it("既定ではツール併用時に reasoning を切る（reasoningEffort=high でも none で送る）", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_000,
					supportsPromptCache: false,
					reasoningEffort: "high",
				},
			})
			const metadata: any = { tools: [{ type: "function", function: { name: "t", parameters: {} } }] }
			for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			expect(mockCreate.mock.calls.at(-1)![0].reasoning_effort).toBe("none")
		})

		it("openAiReasoningWithTools=true ならツール併用時も設定した reasoning を送る", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
				enableReasoningEffort: true,
				openAiReasoningWithTools: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_000,
					supportsPromptCache: false,
					reasoningEffort: "high",
				},
			})
			const metadata: any = { tools: [{ type: "function", function: { name: "t", parameters: {} } }] }
			for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			expect(mockCreate.mock.calls.at(-1)![0].reasoning_effort).toBe("high")
		})

		// パラメータ・マトリクス: streaming / 非ストリーミング × reasoning あり/なし で、
		// temperature と reasoning_effort の送信有無が両経路で一致することを機械的に固定する。
		// （streaming にだけ足して非ストリーミングで落とす、という過去 2 回の drift を検出する。）
		for (const streaming of [true, false]) {
			for (const withReasoning of [true, false]) {
				it(`param matrix: streaming=${streaming}, reasoning=${withReasoning}`, async () => {
					mockCreate.mockImplementationOnce(async () =>
						streaming
							? streamOf([
									{
										choices: [{ delta: {}, index: 0 }],
										usage: { prompt_tokens: 1, completion_tokens: 1 },
									},
								])
							: {
									choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
									usage: { prompt_tokens: 1, completion_tokens: 1 },
								},
					)
					const handler = new OpenAiHandler({
						...mockOptions,
						openAiStreamingEnabled: streaming,
						modelTemperature: 0.4,
						...(withReasoning
							? {
									enableReasoningEffort: true,
									openAiCustomModelInfo: {
										contextWindow: 128_000,
										maxTokens: 16_000,
										supportsPromptCache: false,
										reasoningEffort: "none" as const,
									},
								}
							: {}),
					})
					for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
					const sent = mockCreate.mock.calls.at(-1)![0]
					if (withReasoning) {
						// reasoning モデル: reasoning_effort を送り temperature は送らない（両経路とも）。
						expect(sent.reasoning_effort).toBe("none")
						expect("temperature" in sent).toBe(false)
					} else {
						// 非 reasoning: temperature を送り reasoning_effort は送らない（両経路とも）。
						expect(sent.temperature).toBe(0.4)
						expect("reasoning_effort" in sent).toBe(false)
					}
				})
			}
		}

		it("times out a hung request via race even if abort does not work, surfacing [sent]", async () => {
			vi.useFakeTimers()
			try {
				// create が**永遠に resolve しない**＝応答が返らず、しかも abort も効かない環境を模す
				// （signal を無視する）。それでも race で拡張側がタイムアウトを表面化することを検証。
				mockCreate.mockImplementationOnce(() => new Promise(() => {}))
				const handler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
				const caught = (async () => {
					for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
				})().catch((e) => e)
				// requestTimeoutMs（既定 600000ms）を越えて進める → race がタイムアウトで reject。
				await vi.advanceTimersByTimeAsync(600_001)
				const err = await caught
				expect(err).toBeInstanceOf(Error)
				expect(err.message).toContain("timed out")
				expect(err.message).toContain("[sent]")
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not arm the watchdog when the timeout is unlimited (apiRequestTimeout=0)", async () => {
			// streaming で回すことで、arm の早期 return・reset/clear の timer 未設定分岐を一括で踏む。
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					{ choices: [{ delta: { content: "hi" }, index: 0 }] },
					{
						choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)
			const handler = new OpenAiHandler(mockOptions)
			// 0（無制限）を模す: requestTimeoutMs = undefined。タイマーを張らない経路を踏む。
			;(handler as unknown as { requestTimeoutMs?: number }).requestTimeoutMs = undefined
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages)) chunks.push(c)
			expect(chunks.find((c) => c.type === "text")?.text).toBe("hi")
		})

		it("wraps errors thrown by a non-streaming request", async () => {
			mockCreate.mockRejectedValueOnce(new Error("boom-nonstream"))
			const handler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
			await expect(async () => {
				for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			}).rejects.toThrow("boom-nonstream")
		})

		it("attaches the sent request summary to a streaming error (送信内容が見える)", async () => {
			mockCreate.mockRejectedValueOnce(new Error("boom-400"))
			const handler = new OpenAiHandler(mockOptions)
			const metadata: any = { tools: [{ type: "function", function: { name: "t", parameters: {} } }] }
			let caught: any
			try {
				for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			} catch (e) {
				caught = e
			}
			// 元のメッセージは残しつつ、末尾に [sent] で送信の要点が付く。
			expect(caught.message).toContain("boom-400")
			expect(caught.message).toContain("[sent]")
			expect(caught.message).toContain("model=")
			expect(caught.message).toContain("stream=true")
			expect(caught.message).toContain("stream_options=")
			expect(caught.message).toContain("parallel_tool_calls=")
			// tools は本数だけ（本文は載せない）。
			expect(caught.message).toContain("tools=1")
			// 構造化アクセス用フィールドも付く。
			expect(caught.sentRequestSummary).toContain("model=")
			// messages の本文は載せない。
			expect(caught.message).not.toContain("messages=")
		})

		it("sent summary omits temperature and shows reasoning_effort for reasoning models", async () => {
			mockCreate.mockRejectedValueOnce(new Error("boom-reasoning"))
			const handler = new OpenAiHandler({
				...mockOptions,
				modelTemperature: 0.5,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_000,
					supportsPromptCache: false,
					reasoningEffort: "none",
				},
			})
			let caught: any
			try {
				for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			} catch (e) {
				caught = e
			}
			expect(caught.sentRequestSummary).toContain("reasoning_effort=none")
			expect(caught.sentRequestSummary).not.toContain("temperature=")
		})

		it("passes tools in non-streaming mode and yields empty text when content is null", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})
			const handler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
			const metadata: any = {
				taskId: "t",
				tools: [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }],
				tool_choice: "none",
				parallelToolCalls: false,
			}
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages, metadata)) chunks.push(c)
			expect(chunks.find((c) => c.type === "text")?.text).toBe("")
			expect(mockCreate.mock.calls.at(-1)![0].parallel_tool_calls).toBe(false)
		})

		it("flattens array content for developer/system and assistant roles (renderPartsAsText)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			const messages: any[] = [
				{
					type: "message",
					role: "developer",
					content: [
						{ type: "output_text", text: "sys-part" },
						{ type: "input_image", image_url: "http://x/y.png" },
					],
				},
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "assist" }] },
				{ type: "function_call", call_id: "c1", name: "fn", arguments: "{}" },
			]
			const handler = new OpenAiHandler(mockOptions)
			for await (const _ of handler.createMessage(systemPrompt, messages)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			const assistantMsg = sent.messages.find((m: any) => m.role === "assistant" && typeof m.content === "string")
			expect(assistantMsg.content).toBe("assist")
			const devMsg = sent.messages.find(
				(m: any) => m.role === "system" && typeof m.content === "string" && m.content.includes("sys-part"),
			)
			// image は "[image]" マーカーへ平坦化される。
			expect(devMsg.content).toContain("[image]")
		})

		it("omits temperature when reasoning is configured (GPT-5.6 系は temperature で 400)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			// reasoningEffort をモデル情報に持たせると reasoning_effort が送られる（reasoning モデル扱い）。
			const handler = new OpenAiHandler({
				...mockOptions,
				modelTemperature: 0.5,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 16_000,
					supportsPromptCache: false,
					reasoningEffort: "none",
				},
			})
			for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			// reasoning_effort は送るが temperature は載せない（明示 0.5 を指定していても）。
			expect(sent.reasoning_effort).toBe("none")
			expect("temperature" in sent).toBe(false)
		})

		it("still sends temperature when reasoning is not configured", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			const handler = new OpenAiHandler({ ...mockOptions, modelTemperature: 0.3 })
			for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			expect(sent.temperature).toBe(0.3)
		})

		it("sends tool_calls with empty-string content, not null (Azure 互換は null を拒む)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			const messages: any[] = [
				{ type: "message", role: "user", content: "q" },
				{ type: "function_call", call_id: "c1", name: "fn", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "r" },
			]
			const handler = new OpenAiHandler(mockOptions)
			for await (const _ of handler.createMessage(systemPrompt, messages)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			const assistantWithTools = sent.messages.find((m: any) => m.role === "assistant" && m.tool_calls)
			expect(assistantWithTools.content).toBe("")
			expect(assistantWithTools.content).not.toBeNull()
		})

		it("folds assistant preamble text into the same message as the tool_calls (Azure は assistant 2 連続を拒む)", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([{ choices: [{ delta: {}, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]),
			)
			const messages: any[] = [
				{ type: "message", role: "user", content: "Q1" },
				{ type: "message", role: "assistant", content: "調べます" },
				{ type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' },
				{ type: "function_call_output", call_id: "c1", output: "内容" },
				{ type: "message", role: "assistant", content: "answer" },
				{ type: "message", role: "user", content: "Q2" },
			]
			const handler = new OpenAiHandler(mockOptions)
			for await (const _ of handler.createMessage(systemPrompt, messages)) void _
			const sent = mockCreate.mock.calls.at(-1)![0]
			// system を除いた本体。前置きテキストと tool_calls が同じ 1 メッセージに畳まれる。
			const body = sent.messages.filter((m: any) => m.role !== "system")
			const toolMsg = body.find((m: any) => m.role === "assistant" && m.tool_calls)
			expect(toolMsg.content).toBe("調べます")
			expect(toolMsg.tool_calls).toHaveLength(1)
			// assistant メッセージが 2 連続しない（本文だけの余分な assistant が無い）。
			const assistantsBeforeTool = body.slice(0, body.indexOf(toolMsg))
			expect(assistantsBeforeTool.some((m: any) => m.role === "assistant")).toBe(false)
		})

		it("re-throws non-Error values from completePrompt untouched", async () => {
			const handler = new OpenAiHandler(mockOptions)
			// getModel を非 Error で失敗させ、外側 catch の `instanceof Error` false 側を踏む。
			vi.spyOn(handler, "getModel").mockImplementationOnce(() => {
				throw "string-failure"
			})
			await expect(handler.completePrompt("p")).rejects.toBe("string-failure")
		})

		it("wraps errors thrown by O3-family streaming requests", async () => {
			mockCreate.mockRejectedValueOnce(new Error("o3-stream-boom"))
			const handler = new OpenAiHandler({ ...mockOptions, openAiModelId: "o3-mini" })
			await expect(async () => {
				for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			}).rejects.toThrow("o3-stream-boom")
		})

		it("wraps errors thrown by O3-family non-streaming requests", async () => {
			mockCreate.mockRejectedValueOnce(new Error("o3-nonstream-boom"))
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "o3-mini",
				openAiStreamingEnabled: false,
			})
			await expect(async () => {
				for await (const _ of handler.createMessage(systemPrompt, userMessages)) void _
			}).rejects.toThrow("o3-nonstream-boom")
		})

		it("passes a dispatcher to fetchOptions when a proxy is configured", () => {
			process.env.HTTPS_PROXY = "http://proxy.local:3128"
			_resetProxyDispatcherCache()
			try {
				const handler = new OpenAiHandler(mockOptions)
				expect(handler).toBeInstanceOf(OpenAiHandler)
				const ctorArg = (vi.mocked(OpenAI).mock.calls.at(-1) as any)?.[0]
				expect(ctorArg.fetchOptions?.dispatcher).toBeDefined()
			} finally {
				delete process.env.HTTPS_PROXY
				_resetProxyDispatcherCache()
			}
		})

		const o3ModelInfo = {
			contextWindow: 128_000,
			supportsPromptCache: false,
			reasoningEffort: "medium" as const,
		}

		it("O3 streaming: threads tools/tool_choice/parallelToolCalls and clamps missing usage tokens", async () => {
			mockCreate.mockImplementationOnce(async () =>
				streamOf([
					{ choices: [{ delta: { content: "hi" }, index: 0 }], finish_reason: null },
					// usage は存在するが token フィールドが無い → `|| 0`
					{ choices: [{ delta: {}, index: 0 }], usage: {} },
				]),
			)
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "o3-mini",
				openAiCustomModelInfo: o3ModelInfo,
			})
			const metadata: any = {
				taskId: "t",
				tools: [{ type: "function", function: { name: "t1", parameters: { type: "object", properties: {} } } }],
				tool_choice: "auto",
				parallelToolCalls: false,
			}
			const chunks: any[] = []
			for await (const c of handler.createMessage(systemPrompt, userMessages, metadata)) chunks.push(c)
			const args = mockCreate.mock.calls.at(-1)![0]
			expect(args.tool_choice).toBe("auto")
			expect(args.parallel_tool_calls).toBe(false)
			expect(args.tools?.[0]?.function?.name).toBe("t1")
			expect(chunks.find((c) => c.type === "usage")).toMatchObject({ inputTokens: 0, outputTokens: 0 })
		})

		it("O3 non-streaming (Azure): threads tools/tool_choice/parallel and uses the Azure inference path", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "o3-mini",
				openAiStreamingEnabled: false,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				openAiCustomModelInfo: o3ModelInfo,
			})
			const metadata: any = {
				taskId: "t",
				tools: [{ type: "function", function: { name: "t2", parameters: { type: "object", properties: {} } } }],
				tool_choice: "required",
				parallelToolCalls: false,
			}
			for await (const _ of handler.createMessage(systemPrompt, userMessages, metadata)) void _
			const [args, opts] = mockCreate.mock.calls.at(-1)!
			expect(args.tool_choice).toBe("required")
			expect(args.parallel_tool_calls).toBe(false)
			expect(args.tools?.[0]?.function?.name).toBe("t2")
			expect(opts).toEqual({ path: "/models/chat/completions" })
		})
	})
})

describe("getOpenAiModels", () => {
	beforeEach(() => {
		mockedFetch.mockReset()
	})

	it("should return empty array when baseUrl is not provided", async () => {
		const result = await getOpenAiModels(undefined, "test-key")
		expect(result).toEqual([])
		expect(mockedFetch).not.toHaveBeenCalled()
	})

	it("should return empty array when baseUrl is empty string", async () => {
		const result = await getOpenAiModels("", "test-key")
		expect(result).toEqual([])
		expect(mockedFetch).not.toHaveBeenCalled()
	})

	it("should trim whitespace from baseUrl", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		const result = await getOpenAiModels("  https://api.openai.com/v1  ", "test-key")

		expect(mockedFetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.any(Object))
		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})

	it("should handle baseUrl with trailing spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }, { id: "model-2" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		const result = await getOpenAiModels("https://api.example.com/v1 ", "test-key")

		expect(mockedFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1", "model-2"])
	})

	it("should handle baseUrl with leading spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		const result = await getOpenAiModels(" https://api.example.com/v1", "test-key")

		expect(mockedFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1"])
	})

	it("should return empty array for invalid URL after trimming", async () => {
		const result = await getOpenAiModels("   not-a-valid-url   ", "test-key")
		expect(result).toEqual([])
		expect(mockedFetch).not.toHaveBeenCalled()
	})

	it("should include authorization header when apiKey is provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		await getOpenAiModels("https://api.example.com/v1", "test-api-key")

		expect(mockedFetch).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer test-api-key",
				}),
			}),
		)
	})

	it("should include custom headers when provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		const customHeaders = {
			"X-Custom-Header": "custom-value",
		}

		await getOpenAiModels("https://api.example.com/v1", "test-key", customHeaders)

		expect(mockedFetch).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Custom-Header": "custom-value",
					Authorization: "Bearer test-key",
				}),
			}),
		)
	})

	it("should handle API errors gracefully", async () => {
		mockedFetch.mockRejectedValueOnce(new Error("Network error"))

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should handle malformed response data", async () => {
		mockedFetch.mockResolvedValueOnce(fetchOk(null))

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should deduplicate model IDs", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-4" }, { id: "gpt-3.5-turbo" }, { id: "gpt-4" }],
			},
		}
		mockedFetch.mockResolvedValueOnce(fetchOk(mockResponse.data))

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})

	it("returns empty array when the response is not ok", async () => {
		mockedFetch.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response)
		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")
		expect(result).toEqual([])
	})

	it("drops entries whose id is falsy (empty object) but keeps truthy ids", async () => {
		// getOpenAiModels は `!!id` で truthy フィルタするだけなので、数値 id は残る。
		mockedFetch.mockResolvedValueOnce(fetchOk({ data: [{ id: "a" }, { id: 123 }, {}] }))
		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")
		expect(result).toEqual(["a", 123])
	})

	// VS Code は拡張ホストのグローバル fetch を差し替え、undici の dispatcher を認識しない。
	// proxy が要るときはグローバル fetch を通ってはいけない（undici の fetch へ回す）。
	it("does not go through the patched global fetch when a proxy is configured", async () => {
		process.env.HTTPS_PROXY = "http://proxy.local:3128"
		_resetProxyDispatcherCache()
		try {
			mockedFetch.mockResolvedValueOnce(fetchOk({ data: [{ id: "m1" }] }))
			await getOpenAiModels("https://api.example.com/v1", "test-key")
			expect(mockedFetch).not.toHaveBeenCalled()
		} finally {
			delete process.env.HTTPS_PROXY
			_resetProxyDispatcherCache()
		}
	})
})
