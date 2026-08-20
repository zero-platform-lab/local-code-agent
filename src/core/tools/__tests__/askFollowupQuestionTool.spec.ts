import { askFollowupQuestionTool } from "../AskFollowupQuestionTool"
import { ToolUse } from "../../../shared/tools"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

describe("askFollowupQuestionTool", () => {
	let mockCline: any
	let mockPushToolResult: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockCline = makeMockTask() as any
		mockCline.ask = vi.fn().mockResolvedValue({ text: "Test response" })

		mockPushToolResult = vi.fn()
	})

	it("should parse suggestions without mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [{ text: "Option 1" }, { text: "Option 2" }],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockCline.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining('"suggest":[{"answer":"Option 1"},{"answer":"Option 2"}]'),
			false,
		)
	})

	it("should parse suggestions with mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [
					{ text: "Write code", mode: "code" },
					{ text: "Debug issue", mode: "debug" },
				],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockCline.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining(
				'"suggest":[{"answer":"Write code","mode":"code"},{"answer":"Debug issue","mode":"debug"}]',
			),
			false,
		)
	})

	it("should handle mixed suggestions with and without mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [{ text: "Regular option" }, { text: "Plan architecture", mode: "architect" }],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockCline.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining(
				'"suggest":[{"answer":"Regular option"},{"answer":"Plan architecture","mode":"architect"}]',
			),
			false,
		)
	})

	describe("parameter validation", () => {
		it("should handle missing follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: undefined as any,
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockCline.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.ask).not.toHaveBeenCalled()
		})

		it("should handle null follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: null as any,
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockCline.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.ask).not.toHaveBeenCalled()
		})

		it("should handle non-array follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: "not an array" as any,
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockCline.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.ask).not.toHaveBeenCalled()
		})

		it("should handle missing question parameter", async () => {
			// question 欠落は follow_up より先に弾く。ここを通すと空の質問が UI に出る。
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {},
				nativeArgs: {
					question: "" as any,
					follow_up: [{ text: "Option 1" }],
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "question")
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockCline.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.ask).not.toHaveBeenCalled()
		})
	})

	describe("想定外入力・例外", () => {
		it("task.ask が投げても落ちず handleError に委譲する", async () => {
			const boom = new Error("ask boom")
			mockCline.ask = vi.fn().mockRejectedValue(boom)
			const handleError = vi.fn()

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Q" },
				nativeArgs: {
					question: "Q",
					follow_up: [{ text: "A" }],
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError,
				pushToolResult: mockPushToolResult,
			})

			expect(handleError).toHaveBeenCalledWith("asking question", boom)
			// 例外時は結果を push しない（不完全な回答を確定させない）。
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})

		it("選択肢に壊れた項目（null）が混ざっても process ごと落ちず handleError に流す", async () => {
			// follow_up は配列だが中身は外部由来。null 項目で s.text 参照が投げる。
			// クラッシュではなく handleError 経路に載ることを不変条件として固定する。
			const handleError = vi.fn()
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Q" },
				nativeArgs: {
					question: "Q",
					follow_up: [null as any, { text: "A" }],
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError,
				pushToolResult: mockPushToolResult,
			})

			expect(handleError).toHaveBeenCalledWith("asking question", expect.any(Error))
		})

		it("回答テキストが無くても空文字として user_feedback を記録する", async () => {
			// task.ask が text 無しで解決する（ユーザが空回答/画像のみ）。text ?? "" に落ちる。
			mockCline.ask = vi.fn().mockResolvedValue({ text: undefined, images: undefined })

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Q" },
				nativeArgs: {
					question: "Q",
					follow_up: [{ text: "A" }],
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockCline, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.say).toHaveBeenCalledWith("user_feedback", "", undefined)
			expect(mockPushToolResult).toHaveBeenCalled()
		})
	})

	describe("handlePartial with native protocol", () => {
		it("should only send question during partial streaming to avoid raw JSON display", async () => {
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				partial: true,
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: [{ text: "Option 1", mode: "code" }, { text: "Option 2" }],
				},
			}

			await askFollowupQuestionTool.handle(mockCline, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// During partial streaming, only the question should be sent (not JSON with suggestions)
			expect(mockCline.ask).toHaveBeenCalledWith("followup", "What would you like to do?", true)
		})

		it("nativeArgs.question を params.question より優先する", async () => {
			// streaming 中の確定値は nativeArgs 側。両者が食い違ったとき nativeArgs が勝つ。
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "STALE params value",
				},
				partial: true,
				nativeArgs: {
					question: "FRESH native value",
					follow_up: [{ text: "Option 1" }],
				},
			}

			await askFollowupQuestionTool.handle(mockCline, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.ask).toHaveBeenCalledWith("followup", "FRESH native value", true)
		})

		it("should handle partial with question from params", async () => {
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "Choose wisely",
				},
				partial: true,
			}

			await askFollowupQuestionTool.handle(mockCline, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.ask).toHaveBeenCalledWith("followup", "Choose wisely", true)
		})

		it("question がどこにも無ければ空文字で表示する（生 JSON を出さない）", async () => {
			// nativeArgs も params.question も無い partial。question ?? "" に落ちる。
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {},
				partial: true,
			}

			await askFollowupQuestionTool.handle(mockCline, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockCline.ask).toHaveBeenCalledWith("followup", "", true)
		})
	})

	describe("NativeToolCallParser.createPartialToolUse for ask_followup_question", () => {
		beforeEach(() => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()
		})

		it("should build nativeArgs with question and follow_up during streaming", () => {
			// Start a streaming tool call
			NativeToolCallParser.startStreamingToolCall("call_123", "ask_followup_question")

			// Simulate streaming JSON chunks
			const chunk1 = '{"question":"What would you like?","follow_up":[{"text":"Option 1","mode":"code"}'
			const result1 = NativeToolCallParser.processStreamingChunk("call_123", chunk1)

			expect(result1).not.toBeNull()
			expect(result1?.name).toBe("ask_followup_question")
			expect(result1?.params.question).toBe("What would you like?")
			expect(result1?.nativeArgs).toBeDefined()
			// Use type assertion to access the specific fields
			const nativeArgs = result1?.nativeArgs as {
				question: string
				follow_up?: Array<{ text: string; mode?: string }>
			}
			expect(nativeArgs?.question).toBe("What would you like?")
			// partial-json should parse the incomplete array
			expect(nativeArgs?.follow_up).toBeDefined()
		})

		it("should finalize with complete nativeArgs", () => {
			NativeToolCallParser.startStreamingToolCall("call_456", "ask_followup_question")

			// Add complete JSON
			const completeJson =
				'{"question":"Choose an option","follow_up":[{"text":"Yes","mode":"code"},{"text":"No","mode":null}]}'
			NativeToolCallParser.processStreamingChunk("call_456", completeJson)

			const result = NativeToolCallParser.finalizeStreamingToolCall("call_456")

			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("ask_followup_question")
			expect(result?.partial).toBe(false)
			// Type guard: regular tools have type 'tool_use', MCP tools have type 'mcp_tool_use'
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({
					question: "Choose an option",
					follow_up: [
						{ text: "Yes", mode: "code" },
						{ text: "No", mode: null },
					],
				})
			}
		})
	})
})
