import type { ModelInfo, AgentMessage, ContentBlockParam } from "@openai-agent/types"

import { BaseProvider, flattenNullableTypes } from "../base-provider"
import type { ApiStream } from "../../transform/stream"

// countTokens はデフォルトで worker pool を起動する（tiktoken）。テストでは
// 実 worker を回さず、委譲されたことだけを確認したいのでモックする。パスは
// base-provider.ts から見た `../../utils/countTokens` と同一モジュールを指す。
const mockCountTokens = vi.fn(async (_content?: unknown, _opts?: unknown) => 42)
vi.mock("../../../utils/countTokens", () => ({
	countTokens: (content: unknown, opts: unknown) => mockCountTokens(content, opts),
}))

// Create a concrete implementation for testing
class TestProvider extends BaseProvider {
	createMessage(_systemPrompt: string, _messages: AgentMessage[]): ApiStream {
		throw new Error("Not implemented")
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
	}

	// Expose protected method for testing
	public testConvertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		return this.convertToolsForOpenAI(tools)
	}
}

describe("BaseProvider", () => {
	let provider: TestProvider

	beforeEach(() => {
		provider = new TestProvider()
	})

	describe("convertToolsForOpenAI", () => {
		it("should return undefined for undefined input", () => {
			const result = provider.testConvertToolsForOpenAI(undefined)
			expect(result).toBeUndefined()
		})

		it("does not set strict and keeps schema content (nullable が無ければ内容は同一)", () => {
			// strict は付けない。additionalProperties/required も勝手に足さない。
			// nullable 平坦化のため deep copy にはなるが、nullable が無ければ内容は同一。
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBeUndefined()
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
			expect(result?.[0].function.parameters.required).toBeUndefined()
			expect(result).toEqual(tools)
		})

		it("strict:true を剥がす（不整合な strict スキーマの 400 を回避する）", () => {
			// read_file が required:["path"] のみで strict:true を持ち、endpoint に 400 で
			// 弾かれていた。方針は非 strict なので、個別定義の strict:true も除去する。
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "read",
						strict: true,
						parameters: {
							type: "object",
							properties: { path: { type: "string" }, mode: { type: "string" } },
							required: ["path"],
							additionalProperties: false,
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBeUndefined()
			// スキーマ本体（properties/required 等）は保持。
			expect(result?.[0].function.parameters.required).toEqual(["path"])
			expect(Object.keys(result?.[0].function.parameters.properties)).toEqual(["path", "mode"])
		})

		it('flattens nullable type arrays (type: ["string","null"] → "string") で 400 を回避する', () => {
			// 一部 endpoint/proxy は nullable 型配列を 400(no body) で弾く。単一型に平坦化する。
			const tools = [
				{
					type: "function",
					function: {
						name: "execute_command",
						description: "run",
						parameters: {
							type: "object",
							properties: {
								command: { type: "string" },
								cwd: { type: ["string", "null"] },
								timeout: { type: ["number", "null"] },
							},
							required: ["command"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const props = result?.[0].function.parameters.properties

			expect(props.command.type).toBe("string")
			expect(props.cwd.type).toBe("string") // ["string","null"] → "string"
			expect(props.timeout.type).toBe("number") // ["number","null"] → "number"
			expect(result?.[0].function.parameters.required).toEqual(["command"]) // required は保持
			expect(result?.[0].function.strict).toBeUndefined()
		})

		it("preserves MCP tool schemas unchanged", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: {
							type: "object",
							properties: { token: { type: "string" } },
							required: ["token"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBeUndefined()
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
			expect(result?.[0].function.parameters.required).toEqual(["token"])
		})

		it("should preserve non-function tools unchanged", () => {
			const tools = [
				{
					type: "other_type",
					data: "some data",
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0]).toEqual(tools[0])
		})
	})

	describe("flattenNullableTypes", () => {
		it("null を除いて複数型が残る場合は配列のまま返す", () => {
			expect(flattenNullableTypes({ type: ["string", "number", "null"] })).toEqual({
				type: ["string", "number"],
			})
		})

		it("プリミティブ・null・数値はそのまま返す", () => {
			expect(flattenNullableTypes("x")).toBe("x")
			expect(flattenNullableTypes(null)).toBe(null)
			expect(flattenNullableTypes(5)).toBe(5)
		})

		it("入れ子（配列/オブジェクト）も再帰的に平坦化する", () => {
			const out = flattenNullableTypes({
				type: "object",
				properties: { items: { type: "array", items: { type: ["string", "null"] } } },
				oneOfLike: [{ type: ["number", "null"] }],
			})
			expect(out.properties.items.items.type).toBe("string")
			expect(out.oneOfLike[0].type).toBe("number")
		})
	})

	describe("countTokens", () => {
		beforeEach(() => {
			mockCountTokens.mockClear()
		})

		it("returns 0 without touching the tokenizer for empty content", async () => {
			const result = await provider.countTokens([])
			expect(result).toBe(0)
			expect(mockCountTokens).not.toHaveBeenCalled()
		})

		it("delegates to the tiktoken helper (worker enabled) for non-empty content", async () => {
			const content: ContentBlockParam[] = [{ type: "text", text: "hello world" }]
			const result = await provider.countTokens(content)
			expect(result).toBe(42)
			expect(mockCountTokens).toHaveBeenCalledWith(content, { useWorker: true })
		})
	})
})
