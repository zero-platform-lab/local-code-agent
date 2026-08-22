// npx vitest run src/core/tools/__tests__/validateToolUse.spec.ts

import type { ModeConfig } from "@openai-agent/types"

import { modes } from "../../../shared/modes"
import { TOOL_GROUPS } from "../../../shared/tools"

import { validateToolUse, isToolAllowedForMode, isValidToolName } from "../validateToolUse"

const codeMode = modes.find((m) => m.slug === "code")?.slug || "code"
// 組み込みモードは code の 1 件だけ。「read と mcp しか持たないモード」は
// カスタムモードで表現できるので、グループによるツール制限はそちらで検証する。
const readOnlyMode: ModeConfig = {
	slug: "read-only-mode",
	name: "Read Only",
	roleDefinition: "You investigate",
	groups: ["read", "mcp"],
}

describe("mode-validator", () => {
	describe("isToolAllowedForMode", () => {
		describe("code mode", () => {
			it("allows all code mode tools", () => {
				// Code mode has all groups
				Object.entries(TOOL_GROUPS).forEach(([_, config]) => {
					config.tools.forEach((tool: string) => {
						expect(isToolAllowedForMode(tool, codeMode, [])).toBe(true)
					})
				})
			})

			it("disallows unknown tools", () => {
				expect(isToolAllowedForMode("unknown_tool" as any, codeMode, [])).toBe(false)
			})
		})

		describe("read と mcp だけを持つモード", () => {
			it("allows configured tools", () => {
				const allowed = [...TOOL_GROUPS.read.tools, ...TOOL_GROUPS.mcp.tools]
				allowed.forEach((tool) => {
					expect(isToolAllowedForMode(tool, readOnlyMode.slug, [readOnlyMode])).toBe(true)
				})
			})

			it("編集グループのツールは許可しない", () => {
				TOOL_GROUPS.edit.tools.forEach((tool) => {
					expect(isToolAllowedForMode(tool, readOnlyMode.slug, [readOnlyMode])).toBe(false)
				})
			})
		})

		describe("custom modes", () => {
			it("allows tools from custom mode configuration", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Should allow tools from read and edit groups
				expect(isToolAllowedForMode("read_file", "custom-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("execute_command", "custom-mode", customModes)).toBe(false)
			})

			it("allows custom mode to override built-in mode", () => {
				const customModes: ModeConfig[] = [
					{
						slug: codeMode,
						name: "Custom Code Mode",
						roleDefinition: "Custom role",
						groups: ["read"] as const,
					},
				]
				// Should allow tools from read group
				expect(isToolAllowedForMode("read_file", codeMode, customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("write_to_file", codeMode, customModes)).toBe(false)
			})

			it("respects tool requirements in custom modes", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["edit"] as const,
					},
				]
				const requirements = { apply_diff: false }

				// Should respect disabled requirement even if tool group is allowed
				expect(isToolAllowedForMode("apply_diff", "custom-mode", customModes, requirements)).toBe(false)

				// Should allow other edit tools
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes, requirements)).toBe(true)
			})
		})

		describe("dynamic MCP tools", () => {
			it("allows dynamic MCP tools when mcp group is in mode groups", () => {
				// Code mode has mcp group, so dynamic MCP tools should be allowed
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", codeMode, [])).toBe(true)
				expect(isToolAllowedForMode("mcp_serverName_toolName", codeMode, [])).toBe(true)
			})

			it("disallows dynamic MCP tools when mcp group is not in mode groups", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "no-mcp-mode",
						name: "No MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Custom mode without mcp group should not allow dynamic MCP tools
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "no-mcp-mode", customModes)).toBe(false)
				expect(isToolAllowedForMode("mcp_serverName_toolName", "no-mcp-mode", customModes)).toBe(false)
			})

			it("allows dynamic MCP tools in custom mode with mcp group", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mcp-mode",
						name: "Custom MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "mcp"] as const,
					},
				]
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "custom-mcp-mode", customModes)).toBe(
					true,
				)
			})
		})

		describe("tool requirements", () => {
			it("respects tool requirements when provided", () => {
				const requirements = { apply_diff: false }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(false)

				const enabledRequirements = { apply_diff: true }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], enabledRequirements)).toBe(true)
			})

			it("allows tools when their requirements are not specified", () => {
				const requirements = { some_other_tool: true }
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(true)
			})

			it("handles undefined and empty requirements", () => {
				expect(isToolAllowedForMode("apply_diff", codeMode, [], undefined)).toBe(true)
				expect(isToolAllowedForMode("apply_diff", codeMode, [], {})).toBe(true)
			})

			it("prioritizes requirements over mode configuration", () => {
				const requirements = { apply_diff: false }
				// Even in code mode which allows all tools, disabled requirement should take precedence
				expect(isToolAllowedForMode("apply_diff", codeMode, [], requirements)).toBe(false)
			})

			it("prioritizes requirements over ALWAYS_AVAILABLE_TOOLS", () => {
				// Tools in ALWAYS_AVAILABLE_TOOLS (new_task, attempt_completion, etc.) should still
				// be blockable via toolRequirements / disabledTools
				const requirements = { new_task: false, attempt_completion: false }
				expect(isToolAllowedForMode("new_task", codeMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("new_task", codeMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("attempt_completion", codeMode, [], requirements)).toBe(false)
			})
		})
	})

	describe("validateToolUse", () => {
		it("throws error for unknown/invalid tools", () => {
			// Unknown tools should throw with a specific "Unknown tool" error
			expect(() => validateToolUse("unknown_tool" as any, "architect", [])).toThrow(
				'Unknown tool "unknown_tool". This tool does not exist.',
			)
		})

		it("throws error for disallowed tools in a read-only mode", () => {
			// execute_command は正当なツールだが、command グループを持たないモードでは通さない
			expect(() => validateToolUse("execute_command", readOnlyMode.slug, [readOnlyMode])).toThrow(
				`Tool "execute_command" is not allowed in ${readOnlyMode.slug} mode.`,
			)
		})

		it("does not throw for allowed tools in a read-only mode", () => {
			expect(() => validateToolUse("read_file", readOnlyMode.slug, [readOnlyMode])).not.toThrow()
		})

		it("throws error when tool requirement is not met", () => {
			const requirements = { apply_diff: false }
			expect(() => validateToolUse("apply_diff", codeMode, [], requirements)).toThrow(
				'Tool "apply_diff" is not allowed in code mode.',
			)
		})

		it("does not throw when tool requirement is met", () => {
			const requirements = { apply_diff: true }
			expect(() => validateToolUse("apply_diff", codeMode, [], requirements)).not.toThrow()
		})

		it("handles undefined requirements gracefully", () => {
			expect(() => validateToolUse("apply_diff", codeMode, [], undefined)).not.toThrow()
		})

		it("blocks tool when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command", "search_files"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", codeMode, [], toolRequirements)).toThrow(
				'Tool "execute_command" is not allowed in code mode.',
			)
			expect(() => validateToolUse("search_files", codeMode, [], toolRequirements)).toThrow(
				'Tool "search_files" is not allowed in code mode.',
			)
		})

		it("allows non-disabled tools when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("read_file", codeMode, [], toolRequirements)).not.toThrow()
			expect(() => validateToolUse("write_to_file", codeMode, [], toolRequirements)).not.toThrow()
		})

		it("handles empty disabledTools array converted to toolRequirements", () => {
			const disabledTools: string[] = []
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", codeMode, [], toolRequirements)).not.toThrow()
		})
	})
})

// 以下は既存スイートで未到達だった分岐を埋める。守るのは
//  - 未知ツールの拒否／MCP 動的ツールの受理（isValidToolName）
//  - モードのファイル制限（fileRegex）が編集操作を確実にブロックすること
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

	describe("validateToolUse - customModes 省略", () => {
		it("customModes を渡さなくても既定モードで検証できる（?? [] の既定側）", () => {
			expect(() => validateToolUse("read_file", codeMode)).not.toThrow()
		})
	})

	describe("isToolAllowedForMode - toolRequirements と実験フラグ", () => {
		it("toolRequirements が boolean の false なら全ツール無効", () => {
			// オブジェクトではなく false 単体を渡す経路（全面停止）
			expect(isToolAllowedForMode("read_file", codeMode, [], false as unknown as Record<string, boolean>)).toBe(
				false,
			)
		})

		it("実験フラグが off の実験ツールは拒否する", () => {
			// preventFocusDisruption は実験 ID。experiments で false なら弾く
			expect(
				isToolAllowedForMode("preventFocusDisruption", codeMode, [], undefined, undefined, {
					preventFocusDisruption: false,
				}),
			).toBe(false)
		})

		it("実験フラグが on でも、どのグループにも属さなければ許可されない", () => {
			// on の場合は実験ゲートを通過するが、実ツールではないので最終的に false
			expect(
				isToolAllowedForMode("preventFocusDisruption", codeMode, [], undefined, undefined, {
					preventFocusDisruption: true,
				}),
			).toBe(false)
		})

		it("存在しないモードなら false（mode 解決に失敗）", () => {
			expect(isToolAllowedForMode("read_file", "no-such-mode", [])).toBe(false)
		})
	})

	describe("isToolAllowedForMode - customTools（opt-in）", () => {
		const editOnlyMode: ModeConfig[] = [
			{
				slug: "custom-edit",
				name: "Custom Edit",
				roleDefinition: "role",
				groups: ["edit"] as const,
			},
		]

		it("customTool は includedTools で明示されて初めて許可される", () => {
			// apply_patch は edit グループの customTool。includedTools に入れると許可
			expect(
				isToolAllowedForMode("apply_patch", "custom-edit", editOnlyMode, undefined, undefined, undefined, [
					"apply_patch",
				]),
			).toBe(true)
		})

		it("customTool が includedTools に無ければ許可されない", () => {
			// includedTools 無し → isCustomTool は false → どのグループにも該当せず false
			expect(isToolAllowedForMode("apply_patch", "custom-edit", editOnlyMode)).toBe(false)
		})
	})

	describe("isToolAllowedForMode - edit グループの fileRegex 制限", () => {
		/** edit グループに fileRegex を付けたカスタムモード。 */
		function mdOnlyMode(pattern = "\\.md$"): ModeConfig[] {
			return [
				{
					slug: "md-only",
					name: "Docs",
					roleDefinition: "role",
					groups: ["read", ["edit", { fileRegex: pattern, description: "Markdown のみ" }]],
				} as ModeConfig,
			]
		}

		it("パターンに合わない編集はブロック（FileRestrictionError）", () => {
			expect(() =>
				isToolAllowedForMode("write_to_file", "md-only", mdOnlyMode(), undefined, {
					path: "src/app.ts",
					content: "x",
				}),
			).toThrow(/can only edit files matching pattern/)
		})

		it("パターンに合う編集は許可", () => {
			expect(
				isToolAllowedForMode("write_to_file", "md-only", mdOnlyMode(), undefined, {
					path: "docs/readme.md",
					content: "x",
				}),
			).toBe(true)
		})

		it("path だけ（編集操作パラメータ無し）ならストリーミング表示扱いでブロックしない", () => {
			// 制限に外れる path でも、diff/content 等が無ければ許可（未確定入力を弾かない）
			expect(
				isToolAllowedForMode("write_to_file", "md-only", mdOnlyMode(), undefined, { path: "src/app.ts" }),
			).toBe(true)
		})

		it("file_path 側のキーでも制限を評価する", () => {
			expect(() =>
				isToolAllowedForMode("write_to_file", "md-only", mdOnlyMode(), undefined, {
					file_path: "src/app.ts",
					content: "x",
				}),
			).toThrow(/can only edit files matching pattern/)
		})

		it("不正な正規表現パターンは『一致しない』扱いになりブロックする", () => {
			// new RegExp("[") は投げる → doesFileMatchRegex は false → 制限に引っかかる
			expect(() =>
				isToolAllowedForMode("write_to_file", "md-only", mdOnlyMode("["), undefined, {
					path: "docs/readme.md",
					content: "x",
				}),
			).toThrow(/can only edit files matching pattern/)
		})

		it("apply_patch は patch 内の各パスを検査し、外れるパスがあればブロック", () => {
			const patch = [
				"*** Begin Patch",
				"*** Add File: docs/ok.md",
				"+ok",
				"*** Update File: src/bad.ts",
				"*** End Patch",
			].join("\n")
			expect(() =>
				isToolAllowedForMode("apply_patch", "md-only", mdOnlyMode(), undefined, { patch }, undefined, [
					"apply_patch",
				]),
			).toThrow(/can only edit files matching pattern.*src\/bad\.ts/s)
		})

		it("apply_patch の全パスがパターンに合えば許可", () => {
			const patch = [
				"*** Begin Patch",
				"*** Add File: docs/a.md",
				"+a",
				"*** Delete File: docs/b.md",
				"*** End Patch",
			].join("\n")
			expect(
				isToolAllowedForMode("apply_patch", "md-only", mdOnlyMode(), undefined, { patch }, undefined, [
					"apply_patch",
				]),
			).toBe(true)
		})

		it("空のパス指定行（マーカーのみ）は無視して落ちない", () => {
			// "*** Add File: "（パス空）は extractFilePathsFromPatch で捨てられる
			const patch = ["*** Begin Patch", "*** Add File: ", "*** End Patch"].join("\n")
			expect(
				isToolAllowedForMode("apply_patch", "md-only", mdOnlyMode(), undefined, { patch }, undefined, [
					"apply_patch",
				]),
			).toBe(true)
		})

		it("options はあるが fileRegex が無ければ、制限なしで許可", () => {
			// edit グループにオプションはあるが fileRegex 未指定 → 制限評価をスキップ
			const noRegex: ModeConfig[] = [
				{
					slug: "opt-no-regex",
					name: "Opt",
					roleDefinition: "role",
					groups: [["edit", { description: "regex 無し" }]],
				} as ModeConfig,
			]
			expect(
				isToolAllowedForMode("write_to_file", "opt-no-regex", noRegex, undefined, {
					path: "anything.ts",
					content: "x",
				}),
			).toBe(true)
		})
	})
})
