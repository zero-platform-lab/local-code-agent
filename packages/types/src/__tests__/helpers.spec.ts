// npx vitest run src/__tests__/helpers.spec.ts
//
// 小さなヘルパ関数の検証。agentmodes スキーマの撤去でカバー済み関数が減り、
// 網羅率が床（lines 79.5% / functions 60%）を割ったため、未カバーのまま
// 残っていたヘルパをここでまとめて検証する。

import { validateSkillName, SkillNameValidationError } from "../skills.js"
import { countEnabledMcpTools, type McpServer } from "../mcp.js"
import { isLegacyReadFileParams } from "../tool-params.js"
import { isModelParameter } from "../model.js"
import { isProviderName, getModelId } from "../provider-settings.js"
import { isGlobalStateKey } from "../global-settings.js"

describe("validateSkillName", () => {
	it("空文字は Empty", () => {
		expect(validateSkillName("")).toEqual({ valid: false, error: SkillNameValidationError.Empty })
	})

	it("長すぎる名前は TooLong", () => {
		expect(validateSkillName("a".repeat(200)).error).toBe(SkillNameValidationError.TooLong)
	})

	it("使えない文字は InvalidFormat", () => {
		expect(validateSkillName("Bad_Name!").error).toBe(SkillNameValidationError.InvalidFormat)
	})

	it("正しい名前は valid", () => {
		expect(validateSkillName("pdf-processing")).toEqual({ valid: true })
	})
})

describe("countEnabledMcpTools", () => {
	const server = (over: Partial<McpServer>): McpServer =>
		({ name: "s", config: "{}", status: "connected", ...over }) as McpServer

	it("接続済みサーバの有効ツールだけを数える", () => {
		const servers = [
			server({
				tools: [
					{ name: "a" },
					{ name: "b", enabledForPrompt: false },
					{ name: "c", enabledForPrompt: true },
				] as McpServer["tools"],
			}),
			server({ disabled: true, tools: [{ name: "d" }] as McpServer["tools"] }),
			server({ status: "connecting", tools: [{ name: "e" }] as McpServer["tools"] }),
			server({ tools: undefined }),
		]

		expect(countEnabledMcpTools(servers)).toEqual({ enabledToolCount: 2, enabledServerCount: 2 })
	})

	it("サーバが無ければ 0", () => {
		expect(countEnabledMcpTools([])).toEqual({ enabledToolCount: 0, enabledServerCount: 0 })
	})
})

describe("isLegacyReadFileParams", () => {
	it("_legacyFormat: true のときだけ true", () => {
		expect(isLegacyReadFileParams({ _legacyFormat: true, path: "a.ts" } as never)).toBe(true)
		expect(isLegacyReadFileParams({ files: [] } as never)).toBe(false)
	})
})

describe("isModelParameter", () => {
	it("既知のパラメータ名は true、未知は false", () => {
		expect(isModelParameter("max_tokens")).toBe(true)
		expect(isModelParameter("not_a_parameter")).toBe(false)
	})
})

describe("isProviderName", () => {
	it("既知のプロバイダ名は true、それ以外と非文字列は false", () => {
		expect(isProviderName("openai")).toBe(true)
		expect(isProviderName("no-such-provider")).toBe(false)
		expect(isProviderName(42)).toBe(false)
	})
})

describe("getModelId", () => {
	it("設定されているモデル ID キーの値を返す", () => {
		expect(getModelId({ apiModelId: "m1" } as never)).toBe("m1")
		expect(getModelId({ openAiModelId: "m2" } as never)).toBe("m2")
		expect(getModelId({} as never)).toBeUndefined()
	})
})

describe("isGlobalStateKey", () => {
	it("global state のキーは true、secret キーと未知キーは false", () => {
		expect(isGlobalStateKey("mode")).toBe(true)
		expect(isGlobalStateKey("openAiApiKey")).toBe(false)
		expect(isGlobalStateKey("no-such-key")).toBe(false)
	})
})
