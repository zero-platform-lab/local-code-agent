// npx vitest run src/core/tools/__tests__/validateToolUse.spec.ts

import { modes } from "../../../shared/modes"
import { TOOL_GROUPS } from "../../../shared/tools"

import { validateToolUse, isToolAllowedForMode, isValidToolName } from "../validateToolUse"

const codeMode = modes.find((m) => m.slug === "code")?.slug || "code"

describe("mode-validator", () => {
	describe("isToolAllowedForMode", () => {
		describe("code mode", () => {
			it("allows all code mode tools", () => {
				// Code mode has all groups
				Object.entries(TOOL_GROUPS).forEach(([_, config]) => {
					config.tools.forEach((tool: string) => {
						expect(isToolAllowedForMode(tool, codeMode)).toBe(true)
					})
				})
			})

			it("disallows unknown tools", () => {
				expect(isToolAllowedForMode("unknown_tool" as any, codeMode)).toBe(false)
			})
		})

		describe("dynamic MCP tools", () => {
			it("allows dynamic MCP tools when mcp group is in mode groups", () => {
				expect(isToolAllowedForMode("mcp_myServer_someTool", codeMode)).toBe(true)
			})

			it("disallows dynamic MCP tools for unknown modes", () => {
				expect(isToolAllowedForMode("mcp_myServer_someTool", "no-such-mode")).toBe(false)
			})
		})

		describe("tool requirements", () => {
			it("respects tool requirements when provided", () => {
				expect(isToolAllowedForMode("write_to_file", codeMode, { write_to_file: false })).toBe(false)
				expect(isToolAllowedForMode("write_to_file", codeMode, { write_to_file: true })).toBe(true)
			})

			it("allows tools when their requirements are not specified", () => {
				expect(isToolAllowedForMode("write_to_file", codeMode, { other_tool: false })).toBe(true)
			})

			it("handles undefined and empty requirements", () => {
				expect(isToolAllowedForMode("write_to_file", codeMode, undefined)).toBe(true)
				expect(isToolAllowedForMode("write_to_file", codeMode, {})).toBe(true)
			})

			it("prioritizes requirements over ALWAYS_AVAILABLE_TOOLS", () => {
				expect(isToolAllowedForMode("attempt_completion", codeMode, { attempt_completion: false })).toBe(false)
			})
		})
	})

	describe("validateToolUse", () => {
		it("throws error for unknown/invalid tools", () => {
			expect(() => validateToolUse("does_not_exist" as never, codeMode)).toThrow(/Unknown tool/)
		})

		it("throws error for disallowed tools in a read-only autonomy mode", () => {
			expect(() => validateToolUse("write_to_file", codeMode, undefined, undefined, undefined, "plan")).toThrow(
				/read-only/,
			)
		})

		it("does not throw for allowed tools in a read-only autonomy mode", () => {
			expect(() => validateToolUse("read_file", codeMode, undefined, undefined, undefined, "plan")).not.toThrow()
		})

		it("throws error when tool requirement is not met", () => {
			expect(() => validateToolUse("write_to_file", codeMode, { write_to_file: false })).toThrow(
				/not allowed in code mode/,
			)
		})

		it("does not throw when tool requirement is met", () => {
			expect(() => validateToolUse("write_to_file", codeMode, { write_to_file: true })).not.toThrow()
		})

		it("handles undefined requirements gracefully", () => {
			expect(() => validateToolUse("write_to_file", codeMode)).not.toThrow()
		})
	})
})

// このファイルの狙い:
//  - 到達不能・境界（モード不明・全ツール無効・実験フラグ）で壊れないこと
describe("validateToolUse - 追加分岐", () => {
	describe("isValidToolName", () => {
		it("静的な既知ツールは valid", () => {
			expect(isValidToolName("read_file")).toBe(true)
		})

		it("mcp_ で始まる動的ツールは valid", () => {
			expect(isValidToolName("mcp_myServer_someTool")).toBe(true)
		})

		it("未知の名前は invalid", () => {
			expect(isValidToolName("edit_file_does_not_exist")).toBe(false)
		})
	})

	describe("isToolAllowedForMode - toolRequirements と実験フラグ", () => {
		it("toolRequirements が boolean の false なら全ツール無効", () => {
			// オブジェクトではなく false 単体を渡す経路（全面停止）
			expect(isToolAllowedForMode("read_file", codeMode, false as unknown as Record<string, boolean>)).toBe(false)
		})

		it("実験フラグが off の実験ツールは拒否する", () => {
			// preventFocusDisruption は実験 ID。experiments で false なら弾く
			expect(
				isToolAllowedForMode("preventFocusDisruption", codeMode, undefined, {
					preventFocusDisruption: false,
				}),
			).toBe(false)
		})

		it("実験フラグが on でも、どのグループにも属さなければ許可されない", () => {
			// on の場合は実験ゲートを通過するが、実ツールではないので最終的に false
			expect(
				isToolAllowedForMode("preventFocusDisruption", codeMode, undefined, {
					preventFocusDisruption: true,
				}),
			).toBe(false)
		})

		it("存在しないモードなら false（mode 解決に失敗）", () => {
			expect(isToolAllowedForMode("read_file", "no-such-mode")).toBe(false)
		})
	})

	describe("isToolAllowedForMode - customTools（opt-in）", () => {
		it("customTool は includedTools で明示されて初めて許可される", () => {
			// apply_patch は edit グループの customTool。includedTools に入れると許可
			expect(isToolAllowedForMode("apply_patch", codeMode, undefined, undefined, ["apply_patch"])).toBe(true)
		})

		it("customTool が includedTools に無ければ許可されない", () => {
			// includedTools 無し → isCustomTool は false → どのグループにも該当せず false
			expect(isToolAllowedForMode("edit", codeMode)).toBe(false)
		})
	})
})
