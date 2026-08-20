// npx vitest core/mentions/__tests__/processUserContentMentions.spec.ts

import { processUserContentMentions } from "../processUserContentMentions"
import { parseMentions } from "../index"
import { FileContextTracker } from "../../context-tracking/FileContextTracker"

// Mock the parseMentions function
vi.mock("../index", () => ({
	parseMentions: vi.fn(),
}))

describe("processUserContentMentions", () => {
	let mockFileContextTracker: FileContextTracker

	beforeEach(() => {
		vi.clearAllMocks()

		mockFileContextTracker = {} as FileContextTracker

		// Default mock implementation - returns ParseMentionsResult object
		vi.mocked(parseMentions).mockImplementation(async (text) => ({
			text: `parsed: ${text}`,
			mode: undefined,
			contentBlocks: [],
		}))
	})

	describe("content processing", () => {
		it("should process text blocks with <user_message> tags", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "<user_message>Do something</user_message>",
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).toHaveBeenCalled()
			expect(result.content[0]).toEqual({
				type: "text",
				text: "parsed: <user_message>Do something</user_message>",
			})
			expect(result.mode).toBeUndefined()
		})

		it("should not process text blocks without user_message tags", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "Regular text without special tags",
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).not.toHaveBeenCalled()
			expect(result.content[0]).toEqual(userContent[0])
			expect(result.mode).toBeUndefined()
		})

		it("should process tool_result blocks with string content", async () => {
			const userContent = [
				{
					type: "tool_result" as const,
					tool_use_id: "123",
					content: "<user_message>Tool feedback</user_message>",
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).toHaveBeenCalled()
			// String content is now converted to array format to support content blocks
			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{
						type: "text",
						text: "parsed: <user_message>Tool feedback</user_message>",
					},
				],
			})
			expect(result.mode).toBeUndefined()
		})

		it("should process tool_result blocks with array content", async () => {
			const userContent = [
				{
					type: "tool_result" as const,
					tool_use_id: "123",
					content: [
						{
							type: "text" as const,
							text: "<user_message>Array task</user_message>",
						},
						{
							type: "text" as const,
							text: "Regular text",
						},
					],
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).toHaveBeenCalledTimes(1)
			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{
						type: "text",
						text: "parsed: <user_message>Array task</user_message>",
					},
					{
						type: "text",
						text: "Regular text",
					},
				],
			})
			expect(result.mode).toBeUndefined()
		})

		it("should handle mixed content types (text + image)", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "<user_message>First task</user_message>",
				},
				{
					type: "image" as const,
					image: "base64data",
					mediaType: "image/png",
				},
			]

			const result = await processUserContentMentions({
				userContent: userContent as any,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).toHaveBeenCalledTimes(1)
			expect(result.content).toHaveLength(2)
			expect(result.content[0]).toEqual({
				type: "text",
				text: "parsed: <user_message>First task</user_message>",
			})
			expect(result.content[1]).toEqual(userContent[1]) // Image block unchanged
			expect(result.mode).toBeUndefined()
		})
	})

	describe("showAgentIgnoredFiles parameter", () => {
		it("should default showAgentIgnoredFiles to false", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "<user_message>Test default</user_message>",
				},
			]

			await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).toHaveBeenCalledWith(
				"<user_message>Test default</user_message>",
				"/test",
				mockFileContextTracker,
				undefined,
				false, // showAgentIgnoredFiles should default to false
				true, // includeDiagnosticMessages
				50, // maxDiagnosticMessages
				undefined,
				"code",
			)
		})

		it("should respect showAgentIgnoredFiles when explicitly set to false", async () => {
			const userContent = [
				{
					type: "text" as const,
					text: "<user_message>Test explicit false</user_message>",
				},
			]

			await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
				showAgentIgnoredFiles: false,
			})

			expect(parseMentions).toHaveBeenCalledWith(
				"<user_message>Test explicit false</user_message>",
				"/test",
				mockFileContextTracker,
				undefined,
				false,
				true, // includeDiagnosticMessages
				50, // maxDiagnosticMessages
				undefined,
				"code",
			)
		})
	})

	describe("slash command content processing", () => {
		it("should separate slash command content into a new block", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed text",
				slashCommandHelp: "command help",
				mode: undefined,
				contentBlocks: [],
			})

			const userContent = [
				{
					type: "text" as const,
					text: "<user_message>Run command</user_message>",
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content).toHaveLength(2)
			expect(result.content[0]).toEqual({
				type: "text",
				text: "parsed text",
			})
			expect(result.content[1]).toEqual({
				type: "text",
				text: "command help",
			})
		})

		it("should include slash command content in tool_result string content", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed tool output",
				slashCommandHelp: "command help",
				mode: undefined,
				contentBlocks: [],
			})

			const userContent = [
				{
					type: "tool_result" as const,
					tool_use_id: "123",
					content: "<user_message>Tool output</user_message>",
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content).toHaveLength(1)
			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{
						type: "text",
						text: "parsed tool output",
					},
					{
						type: "text",
						text: "command help",
					},
				],
			})
		})

		it("should include slash command content in tool_result array content", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed array item",
				slashCommandHelp: "command help",
				mode: undefined,
				contentBlocks: [],
			})

			const userContent = [
				{
					type: "tool_result" as const,
					tool_use_id: "123",
					content: [
						{
							type: "text" as const,
							text: "<user_message>Array item</user_message>",
						},
					],
				},
			]

			const result = await processUserContentMentions({
				userContent,
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content).toHaveLength(1)
			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{
						type: "text",
						text: "parsed array item",
					},
					{
						type: "text",
						text: "command help",
					},
				],
			})
		})
	})

	describe("mode capture", () => {
		it("captures the mode returned from a text block", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed text",
				mode: "architect",
				contentBlocks: [],
			})

			const result = await processUserContentMentions({
				userContent: [{ type: "text" as const, text: "<user_message>/architect go</user_message>" }],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.mode).toBe("architect")
		})

		it("captures the mode returned from tool_result string content", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed tool text",
				mode: "debug",
				contentBlocks: [],
			})

			const result = await processUserContentMentions({
				userContent: [
					{
						type: "tool_result" as const,
						tool_use_id: "123",
						content: "<user_message>/debug now</user_message>",
					},
				],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.mode).toBe("debug")
		})

		it("captures the mode returned from tool_result array content", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed array text",
				mode: "ask",
				contentBlocks: [],
			})

			const result = await processUserContentMentions({
				userContent: [
					{
						type: "tool_result" as const,
						tool_use_id: "123",
						content: [{ type: "text" as const, text: "<user_message>/ask this</user_message>" }],
					},
				],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.mode).toBe("ask")
		})

		it("keeps only the first mode when multiple blocks provide one", async () => {
			vi.mocked(parseMentions)
				.mockResolvedValueOnce({ text: "first", mode: "architect", contentBlocks: [] })
				.mockResolvedValueOnce({ text: "second", mode: "debug", contentBlocks: [] })

			const result = await processUserContentMentions({
				userContent: [
					{ type: "text" as const, text: "<user_message>first</user_message>" },
					{ type: "text" as const, text: "<user_message>second</user_message>" },
				],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			// 先着優先: 2 個目の mode は commandMode が既に埋まっているので無視される
			expect(result.mode).toBe("architect")
		})
	})

	describe("file/folder content block propagation", () => {
		it("appends content blocks as separate text parts in the text path", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "user text with @path",
				mode: undefined,
				contentBlocks: [
					{ type: "file", path: "a.ts", content: "FILE A" },
					{ type: "folder", path: "dir", content: "FOLDER DIR" },
				],
			})

			const result = await processUserContentMentions({
				userContent: [{ type: "text" as const, text: "<user_message>@/a.ts</user_message>" }],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content).toEqual([
				{ type: "text", text: "user text with @path" },
				{ type: "text", text: "FILE A" },
				{ type: "text", text: "FOLDER DIR" },
			])
		})

		it("appends content blocks in the tool_result string path", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed tool text",
				mode: undefined,
				contentBlocks: [{ type: "file", path: "b.ts", content: "FILE B" }],
			})

			const result = await processUserContentMentions({
				userContent: [
					{
						type: "tool_result" as const,
						tool_use_id: "123",
						content: "<user_message>@/b.ts</user_message>",
					},
				],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{ type: "text", text: "parsed tool text" },
					{ type: "text", text: "FILE B" },
				],
			})
		})

		it("appends content blocks in the tool_result array path", async () => {
			vi.mocked(parseMentions).mockResolvedValueOnce({
				text: "parsed array text",
				mode: undefined,
				contentBlocks: [{ type: "file", path: "c.ts", content: "FILE C" }],
			})

			const result = await processUserContentMentions({
				userContent: [
					{
						type: "tool_result" as const,
						tool_use_id: "123",
						content: [{ type: "text" as const, text: "<user_message>@/c.ts</user_message>" }],
					},
				],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(result.content[0]).toEqual({
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{ type: "text", text: "parsed array text" },
					{ type: "text", text: "FILE C" },
				],
			})
		})
	})

	describe("passthrough (no processing)", () => {
		it("passes through tool_result string content without <user_message> unchanged", async () => {
			const block = {
				type: "tool_result" as const,
				tool_use_id: "123",
				content: "plain tool output without special tags",
			}

			const result = await processUserContentMentions({
				userContent: [block],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).not.toHaveBeenCalled()
			expect(result.content[0]).toEqual(block)
			expect(result.mode).toBeUndefined()
		})

		it("passes through tool_result whose content is neither string nor array", async () => {
			// content が string でも配列でもない場合（undefined 等）はそのまま返す（実装 212 行）
			const block = {
				type: "tool_result" as const,
				tool_use_id: "123",
				content: undefined,
			}

			const result = await processUserContentMentions({
				userContent: [block as any],
				cwd: "/test",
				fileContextTracker: mockFileContextTracker,
			})

			expect(parseMentions).not.toHaveBeenCalled()
			expect(result.content[0]).toEqual(block)
		})
	})
})
