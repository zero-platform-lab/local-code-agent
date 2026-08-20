// npx vitest run core/assistant-message/__tests__/defensiveBranches.spec.ts
//
// ここは「通常入力では到達しないが、依存が Error/文字列以外を返すと通る防御分岐」を、
// 依存を意図的に誤動作させて実測で埋めるためのファイル。ignore コメントに逃げず本物の分岐を通す。
// それぞれ依存モジュールを丸ごと贋物にするので、他の spec と混ざらないよう独立ファイルにしている。
//   1. NativeToolCallParser.parseToolCall: buildNativeArgs が Error 以外を throw した場合の String() 化
//   2. presentToolUse 検証失敗: formatResponse.toolError が文字列以外を返した場合の固定文言

import { describe, it, expect, vi } from "vitest"

import type { ToolUse } from "../../../shared/tools"

// 1) buildNativeArgs が Error でない値を投げる（NativeToolCallParser 用）
vi.mock("../nativeToolArgs", () => ({
	buildNativeArgs: vi.fn(() => {
		// Error インスタンスではない値を投げる → catch 内 `String(error)` 側を通す
		throw { synthetic: true }
	}),
}))

// 2) presentToolUse の検証失敗経路を最短で通すためのモック群
vi.mock("../toolDispatch", () => ({ toolDispatch: {} }))
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(() => {
		throw new Error("nope")
	}),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../describeToolUse", () => ({ describeToolUse: vi.fn(() => "[desc]") }))
vi.mock("../../i18n", () => ({ t: (key: string) => key }))
// toolError がわざと非文字列を返す → `typeof errorContent === "string"` が false になる
vi.mock("../../prompts/responses", () => ({
	formatResponse: { toolError: vi.fn(() => [{ type: "text", text: "x" }]) },
}))

import { NativeToolCallParser } from "../NativeToolCallParser"
import { presentToolUse } from "../presentToolUse"

describe("NativeToolCallParser.parseToolCall — 非 Error の throw", () => {
	it("Error でない値が投げられても String() 化して握りつぶし null を返す", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = NativeToolCallParser.parseToolCall({
			id: "x",
			name: "read_file",
			arguments: JSON.stringify({ path: "a.ts" }),
		})

		expect(result).toBeNull()
		spy.mockRestore()
	})
})

describe("presentToolUse — 検証エラーで toolError が非文字列を返した場合", () => {
	it("非文字列なら固定文言 '(validation error)' を積む", async () => {
		const pushed: Array<Record<string, unknown>> = []
		const cline = {
			taskId: "t",
			instanceId: "i",
			stream: {
				userMessageContent: [] as unknown[],
				didAlreadyUseTool: false,
				didRejectTool: false,
				currentStreamingDidCheckpoint: false,
			},
			mistakeTracker: { count: 0 },
			tokenUsageTracker: { recordToolUsage: vi.fn(), recordToolError: vi.fn() },
			toolRepetitionDetector: { check: vi.fn(() => ({ allowExecution: true })) },
			pushToolResultToUserContent: vi.fn((r: Record<string, unknown>) => {
				pushed.push(r)
				return true
			}),
			providerRef: { deref: () => ({ getState: async () => ({ mode: "code", customModes: [] }) }) },
			api: { getModel: () => ({ id: "m", info: {} }) },
			ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
			say: vi.fn(async () => undefined),
			checkpointSave: vi.fn(async () => undefined),
		}

		const block = {
			type: "tool_use",
			id: "call_1",
			name: "read_file",
			params: { path: "a.ts" },
			partial: false,
			nativeArgs: { path: "a.ts" },
		} as ToolUse

		await presentToolUse(cline as never, block)

		expect(pushed).toHaveLength(1)
		expect(pushed[0].content).toBe("(validation error)")
		expect(pushed[0].is_error).toBe(true)
	})
})
