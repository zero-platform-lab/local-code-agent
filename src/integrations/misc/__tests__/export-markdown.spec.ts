import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import type { MessageParam } from "@openai-agent/types"
import {
	formatContentBlockToMarkdown,
	downloadTask,
	getTaskFileName,
	findToolName,
	ExtendedContentBlock,
} from "../export-markdown"

// showSaveDialog / writeFile を制御するためローカルで vscode を差し替える。
vi.mock("vscode", () => ({
	window: {
		showSaveDialog: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: {
		fs: {
			writeFile: vi.fn(),
		},
	},
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p, path: p, scheme: "file" })),
	},
}))

describe("export-markdown", () => {
	describe("formatContentBlockToMarkdown", () => {
		it("should format text blocks", () => {
			const block = { type: "text", text: "Hello, world!" } as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("Hello, world!")
		})

		it("should format image blocks", () => {
			const block = {
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "data" },
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Image]")
		})

		it("should format tool_use blocks with string input", () => {
			const block = { type: "tool_use", name: "read_file", id: "123", input: "file.txt" } as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool Use: read_file]\nfile.txt")
		})

		it("should format tool_use blocks with object input", () => {
			const block = {
				type: "tool_use",
				name: "read_file",
				id: "123",
				input: { path: "file.txt", line_count: 10 },
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool Use: read_file]\nPath: file.txt\nLine_count: 10")
		})

		it("should format tool_result blocks with string content", () => {
			const block = { type: "tool_result", tool_use_id: "123", content: "File content" } as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool]\nFile content")
		})

		it("should format tool_result blocks with error", () => {
			const block = {
				type: "tool_result",
				tool_use_id: "123",
				content: "Error message",
				is_error: true,
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool (Error)]\nError message")
		})

		it("should format tool_result blocks with array content", () => {
			const block = {
				type: "tool_result",
				tool_use_id: "123",
				content: [
					{ type: "text", text: "Line 1" },
					{ type: "text", text: "Line 2" },
				],
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool]\nLine 1\nLine 2")
		})

		it("should format tool_result blocks with array content and error", () => {
			const block = {
				type: "tool_result",
				tool_use_id: "123",
				is_error: true,
				content: [
					{ type: "text", text: "Line 1" },
					{ type: "text", text: "Line 2" },
				],
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool (Error)]\nLine 1\nLine 2")
		})

		it("should format reasoning blocks", () => {
			const block = { type: "reasoning", text: "Let me think about this..." } as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Reasoning]\nLet me think about this...")
		})

		it("should handle unexpected content types", () => {
			const block = { type: "unknown_type" as const } as any
			expect(formatContentBlockToMarkdown(block)).toBe("[Unexpected content type: unknown_type]")
		})

		it("tool_use のネストした値は JSON 文字列化する", () => {
			// value がオブジェクト/配列のとき JSON.stringify 側の分岐を通す。
			const block = {
				type: "tool_use",
				name: "write",
				id: "1",
				input: { edits: [{ path: "a.ts" }] },
			} as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe(
				'[Tool Use: write]\nEdits: [\n  {\n    "path": "a.ts"\n  }\n]',
			)
		})

		it("tool_result で content が文字列でも配列でもなければラベルだけ返す", () => {
			const block = {
				type: "tool_result",
				tool_use_id: "1",
				content: undefined,
			} as unknown as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool]")
		})

		it("tool_result で content 不定かつエラーなら (Error) を付ける", () => {
			const block = {
				type: "tool_result",
				tool_use_id: "1",
				content: undefined,
				is_error: true,
			} as unknown as ExtendedContentBlock
			expect(formatContentBlockToMarkdown(block)).toBe("[Tool (Error)]")
		})
	})

	describe("getTaskFileName", () => {
		it("午後の時刻は pm・12時間表記になる", () => {
			const ts = new Date(2023, 0, 5, 14, 3, 9).getTime() // jan 5 2023 14:03:09
			expect(getTaskFileName(ts)).toBe("roo_task_jan-5-2023_2-03-09-pm.md")
		})

		it("深夜0時は 12・am になる", () => {
			const ts = new Date(2023, 11, 25, 0, 0, 0).getTime() // dec 25 2023 00:00:00
			expect(getTaskFileName(ts)).toBe("roo_task_dec-25-2023_12-00-00-am.md")
		})

		it("正午は 12・pm のまま（%12 が 0 でも 12 に戻す）", () => {
			const ts = new Date(2023, 5, 15, 12, 30, 45).getTime() // jun 15 2023 12:30:45
			expect(getTaskFileName(ts)).toBe("roo_task_jun-15-2023_12-30-45-pm.md")
		})
	})

	describe("downloadTask", () => {
		const history: MessageParam[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "world" }] },
		] as MessageParam[]

		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("保存先が選ばれたら書き込み・表示して URI を返す", async () => {
			const saveUri = { fsPath: "/out/task.md" }
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(saveUri as never)
			const defaultUri = vscode.Uri.file("/default")

			const result = await downloadTask(123, history, defaultUri as never)

			expect(result).toBe(saveUri)
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1)
			const [uriArg, bufArg] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]
			expect(uriArg).toBe(saveUri)
			// user / assistant 両ロールが本文に載る（role 分岐の両側）
			const text = (bufArg as Buffer).toString()
			expect(text).toContain("**User:**")
			expect(text).toContain("hello")
			expect(text).toContain("**Assistant:**")
			expect(text).toContain("world")
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(saveUri, { preview: true })
		})

		it("**保存ダイアログをキャンセルしたら書き込みは起きず undefined を返す**", async () => {
			vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined)
			const defaultUri = vscode.Uri.file("/default")

			const result = await downloadTask(123, history, defaultUri as never)

			expect(result).toBeUndefined()
			// 不変条件: キャンセル時は 1 度も書き込まない
			expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled()
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})
	})

	describe("findToolName", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "just text" }, // content が配列でない分岐
			{
				role: "assistant",
				content: [
					{ type: "text", text: "thinking" },
					{ type: "tool_use", id: "call-1", name: "read_file", input: {} },
				],
			},
		] as MessageParam[]

		it("一致する tool_use があればその名前を返す", () => {
			expect(findToolName("call-1", messages)).toBe("read_file")
		})

		it("一致しなければ Unknown Tool を返す", () => {
			expect(findToolName("missing", messages)).toBe("Unknown Tool")
		})
	})
})
