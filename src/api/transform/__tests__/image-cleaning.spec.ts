// npx vitest run api/transform/__tests__/image-cleaning.spec.ts

import type { ModelInfo } from "@openai-agent/types"

import { ApiHandler } from "../../index"
import { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../image-cleaning"

describe("maybeRemoveImageBlocks", () => {
	// Mock ApiHandler factory function
	const createMockApiHandler = (supportsImages: boolean): ApiHandler => {
		return {
			getModel: vitest.fn().mockReturnValue({
				id: "test-model",
				info: {
					supportsImages,
				} as ModelInfo,
			}),
			createMessage: vitest.fn(),
			countTokens: vitest.fn(),
		}
	}

	it("should handle empty messages array", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = []

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual([])
	})

	it("should not modify messages with no image blocks", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: "Hello, world!",
			},
			{
				type: "message",
				role: "assistant",
				content: "Hi there!",
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual(messages)
		// getModel は先頭で 1 回だけ呼ばれる（メッセージごとではない）
		expect(apiHandler.getModel).toHaveBeenCalledTimes(1)
	})

	it("should not modify messages with array content but no image blocks", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Hello, world!",
					},
					{
						type: "input_text",
						text: "How are you?",
					},
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		expect(result).toEqual(messages)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should not modify image blocks when API handler supports images", () => {
		const apiHandler = createMockApiHandler(true)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Check out this image:",
					},
					{ type: "input_image", image_url: "data:image/jpeg;base64,base64-encoded-image-data" },
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should not modify the messages since the API handler supports images
		expect(result).toEqual(messages)
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should convert image blocks to text descriptions when API handler doesn't support images", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Check out this image:",
					},
					{ type: "input_image", image_url: "data:image/jpeg;base64,base64-encoded-image-data" },
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert image blocks to text descriptions
		expect(result).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Check out this image:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
				],
			},
		])
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should handle mixed content messages with multiple text and image blocks", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here are some images:",
					},
					{ type: "input_image", image_url: "data:image/jpeg;base64,image-data-1" },
					{
						type: "input_text",
						text: "And another one:",
					},
					{ type: "input_image", image_url: "data:image/png;base64,image-data-2" },
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert all image blocks to text descriptions
		expect(result).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here are some images:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
					{
						type: "input_text",
						text: "And another one:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
				],
			},
		])
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should handle multiple messages with image blocks", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's an image:",
					},
					{ type: "input_image", image_url: "data:image/jpeg;base64,image-data-1" },
				],
			},
			{
				type: "message",
				role: "assistant",
				content: "I see the image!",
			},
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's another image:",
					},
					{ type: "input_image", image_url: "data:image/png;base64,image-data-2" },
				],
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert all image blocks to text descriptions
		expect(result).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's an image:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
				],
			},
			{
				type: "message",
				role: "assistant",
				content: "I see the image!",
			},
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's another image:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
				],
			},
		])
		expect(apiHandler.getModel).toHaveBeenCalled()
	})

	it("should preserve additional message properties", () => {
		const apiHandler = createMockApiHandler(false)
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's an image:",
					},
					{ type: "input_image", image_url: "data:image/jpeg;base64,image-data" },
				],
				ts: 1620000000000,
				isSummary: true,
			},
		]

		const result = maybeRemoveImageBlocks(messages, apiHandler)

		// Should convert image blocks to text descriptions while preserving additional properties
		expect(result).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Here's an image:",
					},
					{
						type: "input_text",
						text: "[Referenced image in conversation]",
					},
				],
				ts: 1620000000000,
				isSummary: true,
			},
		])
		expect(apiHandler.getModel).toHaveBeenCalled()
	})
})
