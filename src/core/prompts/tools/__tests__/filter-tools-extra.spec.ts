// npx vitest run core/prompts/tools/__tests__/filter-tools-extra.spec.ts

import type OpenAI from "openai"
import type { ModeConfig, ModelInfo } from "@openai-agent/types"

import {
	resolveToolAlias,
	applyToolAliases,
	getToolAliasGroup,
	applyModelToolCustomization,
	filterNativeToolsForMode,
	isToolAllowedInMode,
	getAvailableToolsInGroup,
	filterMcpToolsForMode,
} from "../filter-tools-for-mode"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
	} as OpenAI.Chat.ChatCompletionTool
}

const toolName = (t: OpenAI.Chat.ChatCompletionTool) => (t as any).function.name

// code モードのグループを網羅するネイティブツール群
const NATIVE = [
	makeTool("read_file"),
	makeTool("write_to_file"),
	makeTool("edit"),
	makeTool("codebase_search"),
	makeTool("update_todo_list"),
	makeTool("run_slash_command"),
	makeTool("access_mcp_resource"),
	makeTool("execute_command"),
]

const enabledCodeIndex = {
	isFeatureEnabled: true,
	isFeatureConfigured: true,
	isInitialized: true,
} as any

const mcpHubWithResources = {
	getServers: () => [{ name: "s", resources: [{ uri: "x://y" }] }],
} as any

describe("alias helpers", () => {
	it("resolveToolAlias はエイリアスを正規名へ、それ以外はそのまま返す", () => {
		expect(resolveToolAlias("write_file")).toBe("write_to_file")
		expect(resolveToolAlias("search_and_replace")).toBe("edit")
		expect(resolveToolAlias("read_file")).toBe("read_file")
	})

	it("applyToolAliases は集合内のエイリアスを正規名へ解決する", () => {
		const result = applyToolAliases(new Set(["write_file", "read_file"]))
		expect(result.has("write_to_file")).toBe(true)
		expect(result.has("read_file")).toBe(true)
		expect(result.has("write_file")).toBe(false)
	})

	it("getToolAliasGroup は正規名とその全エイリアスを返す", () => {
		const group = getToolAliasGroup("write_to_file")
		expect(group).toContain("write_to_file")
		expect(group).toContain("write_file")
	})

	it("getToolAliasGroup はエイリアスの無いツールでは単独配列を返す", () => {
		expect(getToolAliasGroup("read_file")).toEqual(["read_file"])
	})
})

describe("applyModelToolCustomization", () => {
	const editModeWithArrayGroup: ModeConfig = {
		slug: "arr",
		name: "Arr",
		roleDefinition: "",
		groups: ["edit", "read"],
	} as ModeConfig

	it("modelInfo が無ければ入力をそのまま返し alias 変換は空", () => {
		const input = new Set(["read_file"])
		const result = applyModelToolCustomization(input, editModeWithArrayGroup, undefined)
		expect(result.allowedTools).toBe(input)
		expect(result.aliasRenames.size).toBe(0)
	})

	it("excludedTools はエイリアス解決して除外する", () => {
		const modelInfo = { excludedTools: ["search_and_replace"] } as unknown as ModelInfo
		const result = applyModelToolCustomization(new Set(["edit", "read_file"]), editModeWithArrayGroup, modelInfo)
		expect(result.allowedTools.has("edit")).toBe(false)
		expect(result.allowedTools.has("read_file")).toBe(true)
	})

	it("includedTools は許可グループのものだけ追加し、エイリアス指定は rename を記録する", () => {
		const modelInfo = { includedTools: ["write_file"] } as unknown as ModelInfo
		const result = applyModelToolCustomization(new Set<string>(), editModeWithArrayGroup, modelInfo)
		// write_file → write_to_file (edit グループは許可) を追加
		expect(result.allowedTools.has("write_to_file")).toBe(true)
		// エイリアス指定なので rename を記録
		expect(result.aliasRenames.get("write_to_file")).toBe("write_file")
	})

	it("includedTools が許可グループ外なら追加しない", () => {
		// execute_command は command グループ。editModeWithArrayGroup には command が無い
		const modelInfo = { includedTools: ["execute_command"] } as unknown as ModelInfo
		const result = applyModelToolCustomization(new Set<string>(), editModeWithArrayGroup, modelInfo)
		expect(result.allowedTools.has("execute_command")).toBe(false)
	})
})

describe("filterNativeToolsForMode", () => {
	it("mode 未指定でも既定モードのツールを返す", () => {
		const result = filterNativeToolsForMode(NATIVE, undefined, undefined)
		expect(result.map(toolName)).toContain("read_file")
	})

	it("未知モードでも既定モードにフォールバックする", () => {
		const result = filterNativeToolsForMode(NATIVE, "does-not-exist", undefined)
		expect(result.length).toBeGreaterThan(0)
	})

	it("codeIndexManager が無ければ codebase_search を除外し、有効なら含める", () => {
		const without = filterNativeToolsForMode(NATIVE, "code", undefined)
		expect(without.map(toolName)).not.toContain("codebase_search")

		const withIndex = filterNativeToolsForMode(NATIVE, "code", undefined, enabledCodeIndex)
		expect(withIndex.map(toolName)).toContain("codebase_search")
	})

	it("todoListEnabled=false で update_todo_list を除外する", () => {
		const result = filterNativeToolsForMode(NATIVE, "code", undefined, undefined, {
			todoListEnabled: false,
		})
		expect(result.map(toolName)).not.toContain("update_todo_list")
	})

	it("runSlashCommand 実験が有効なときだけ run_slash_command を含める", () => {
		const off = filterNativeToolsForMode(NATIVE, "code", {})
		expect(off.map(toolName)).not.toContain("run_slash_command")

		const on = filterNativeToolsForMode(NATIVE, "code", { runSlashCommand: true })
		expect(on.map(toolName)).toContain("run_slash_command")
	})

	it("MCP リソースが無ければ access_mcp_resource を除外し、あれば含める", () => {
		const without = filterNativeToolsForMode(NATIVE, "code", undefined)
		expect(without.map(toolName)).not.toContain("access_mcp_resource")

		const withMcp = filterNativeToolsForMode(NATIVE, "code", undefined, undefined, undefined, mcpHubWithResources)
		expect(withMcp.map(toolName)).toContain("access_mcp_resource")
	})

	it("modelInfo.includedTools のエイリアス指定は出力ツール名を rename する", () => {
		const settings = { modelInfo: { includedTools: ["write_file"] } }
		const result = filterNativeToolsForMode(NATIVE, "code", undefined, undefined, settings)
		const names = result.map(toolName)
		// write_to_file が write_file にリネームされて出る
		expect(names).toContain("write_file")
		expect(names).not.toContain("write_to_file")
	})

	it("disabledTools はエイリアスも正規化して除外する", () => {
		const result = filterNativeToolsForMode(NATIVE, "code", undefined, undefined, {
			disabledTools: ["search_and_replace"],
		})
		expect(result.map(toolName)).not.toContain("edit")
	})
})

describe("isToolAllowedInMode", () => {
	it("常時利用可能ツールは true", () => {
		expect(isToolAllowedInMode("attempt_completion", "code", undefined)).toBe(true)
	})

	it("グループ制のツール(codebase_search)はモードのグループに従う", () => {
		// codebase_search は ALWAYS_AVAILABLE ではないため、モードの read グループで許可される
		expect(isToolAllowedInMode("codebase_search", "code", undefined)).toBe(true)
		// 未知モードでは不許可（モード解決に失敗）
		expect(isToolAllowedInMode("codebase_search", "no-such-mode", undefined)).toBe(false)
	})

	it("update_todo_list は todoListEnabled=false のとき false", () => {
		expect(isToolAllowedInMode("update_todo_list", "code", undefined, undefined, {})).toBe(true)
		expect(
			isToolAllowedInMode("update_todo_list", "code", undefined, undefined, {
				todoListEnabled: false,
			}),
		).toBe(false)
	})

	it("run_slash_command は experiment 次第", () => {
		expect(isToolAllowedInMode("run_slash_command", "code", {})).toBe(false)
		expect(isToolAllowedInMode("run_slash_command", "code", { runSlashCommand: true })).toBe(true)
	})

	it("モードのグループに属するツールは許可され、mode 未指定でも既定で判定する", () => {
		expect(isToolAllowedInMode("read_file", "code", undefined)).toBe(true)
		expect(isToolAllowedInMode("read_file", undefined, undefined)).toBe(true)
	})
})

describe("getAvailableToolsInGroup", () => {
	it("未知グループは空配列", () => {
		expect(getAvailableToolsInGroup("bogus" as any, "code", undefined)).toEqual([])
	})

	it("read グループは code モードで read_file を含む", () => {
		const tools = getAvailableToolsInGroup("read", "code", undefined)
		expect(tools).toContain("read_file")
	})
})

describe("filterMcpToolsForMode", () => {
	const mcpTools = [makeTool("mcp--srv--tool")]

	it("use_mcp_tool が許可されるモードでは MCP ツールをそのまま返す", () => {
		const result = filterMcpToolsForMode(mcpTools, "code", undefined)
		expect(result).toEqual(mcpTools)
	})

	it("mode 未指定でも既定モードで判定する", () => {
		// mode ?? defaultModeSlug の nullish 分岐
		const result = filterMcpToolsForMode(mcpTools, undefined, undefined)
		expect(result).toEqual(mcpTools)
	})

	it("未知モードでは use_mcp_tool が許可されず空配列", () => {
		const result = filterMcpToolsForMode(mcpTools, "no-such-mode", undefined)
		expect(result).toEqual([])
	})
})
