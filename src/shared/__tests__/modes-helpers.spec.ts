// npx vitest run shared/__tests__/modes-helpers.spec.ts

import type * as vscode from "vscode"
import type { ModeConfig, CustomModePrompts } from "@openai-agent/types"

import {
	getGroupName,
	getToolsForMode,
	getModeBySlug,
	getModeConfig,
	getAllModes,
	isCustomMode,
	getAllModesWithPrompts,
	getRoleDefinition,
	getDescription,
	getWhenToUse,
	getCustomInstructions,
	modes,
	defaultPrompts,
} from "../modes"

const fullCustom: ModeConfig = {
	slug: "custom-x",
	name: "Custom X",
	roleDefinition: "custom role",
	description: "custom description",
	whenToUse: "custom whenToUse",
	customInstructions: "custom instructions",
	groups: ["read"],
}

// description / whenToUse / customInstructions を省いたモード（?? "" 分岐用）
const minimalCustom: ModeConfig = {
	slug: "custom-min",
	name: "Custom Min",
	roleDefinition: "min role",
	groups: ["read"],
}

describe("getGroupName", () => {
	it("文字列形式のグループ名をそのまま返す", () => {
		expect(getGroupName("read")).toBe("read")
	})
	it("配列形式ではタプル先頭を返す", () => {
		expect(getGroupName(["edit", { fileRegex: "\\.md$" }])).toBe("edit")
	})
})

describe("getToolsForMode", () => {
	it("グループのツールと常時利用ツールを含む", () => {
		const tools = getToolsForMode(["read"])
		expect(Array.isArray(tools)).toBe(true)
		expect(tools).toContain("ask_followup_question")
		expect(tools).toContain("attempt_completion")
		// 重複排除されている
		expect(new Set(tools).size).toBe(tools.length)
	})
})

describe("getModeBySlug", () => {
	it("カスタムモードを優先して返す", () => {
		expect(getModeBySlug("custom-x", [fullCustom])).toBe(fullCustom)
	})
	it("組み込みモードを返す", () => {
		expect(getModeBySlug("code")?.slug).toBe("code")
	})
	it("見つからなければ undefined", () => {
		expect(getModeBySlug("no-such-mode")).toBeUndefined()
	})
})

describe("getModeConfig", () => {
	it("見つかったモードを返す", () => {
		expect(getModeConfig("code").slug).toBe("code")
	})
	it("見つからなければ例外", () => {
		expect(() => getModeConfig("no-such-mode")).toThrow("No mode found for slug: no-such-mode")
	})
})

describe("getAllModes", () => {
	it("カスタム無しなら組み込みモードのコピー", () => {
		const all = getAllModes()
		expect(all).toHaveLength(modes.length)
		expect(all).not.toBe(modes as unknown)
	})
	it("既存 slug のカスタムは上書き", () => {
		const override: ModeConfig = { slug: "code", name: "Overridden", roleDefinition: "over", groups: ["read"] }
		const all = getAllModes([override])
		expect(all).toHaveLength(modes.length)
		expect(all.find((m) => m.slug === "code")?.name).toBe("Overridden")
	})
	it("新規 slug のカスタムは追加", () => {
		const all = getAllModes([fullCustom])
		expect(all).toHaveLength(modes.length + 1)
		expect(all.find((m) => m.slug === "custom-x")).toBe(fullCustom)
	})
})

describe("isCustomMode", () => {
	it("カスタムに含まれれば true", () => {
		expect(isCustomMode("custom-x", [fullCustom])).toBe(true)
	})
	it("含まれなければ false", () => {
		expect(isCustomMode("code", [fullCustom])).toBe(false)
	})
})

describe("getAllModesWithPrompts", () => {
	const makeContext = (customModes: unknown, customModePrompts: unknown) =>
		({
			globalState: {
				get: vi.fn(async (key: string) => {
					if (key === "customModes") return customModes
					if (key === "customModePrompts") return customModePrompts
					return undefined
				}),
			},
		}) as unknown as vscode.ExtensionContext

	it("customModePrompts のオーバーライドを適用しつつ未指定はフォールバック", async () => {
		const prompts: CustomModePrompts = { code: { roleDefinition: "overridden role" } }
		const context = makeContext([fullCustom], prompts)
		const result = await getAllModesWithPrompts(context)

		const code = result.find((m) => m.slug === "code")!
		expect(code.roleDefinition).toBe("overridden role")
		// whenToUse / customInstructions はオーバーライド無し → 元の値
		const builtinCode = modes.find((m) => m.slug === "code")!
		expect(code.customInstructions).toBe(builtinCode.customInstructions)
		// カスタムモードも含まれる
		expect(result.find((m) => m.slug === "custom-x")).toBeDefined()
	})

	it("globalState が空でも既定値へフォールバック（|| [] と || {}）", async () => {
		const context = makeContext(undefined, undefined)
		const result = await getAllModesWithPrompts(context)
		expect(result).toHaveLength(modes.length)
	})
})

describe("安全なゲッター", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("getRoleDefinition は見つかれば roleDefinition、無ければ '' と警告", () => {
		expect(getRoleDefinition("custom-x", [fullCustom])).toBe("custom role")
		expect(getRoleDefinition("no-such-mode")).toBe("")
		expect(console.warn).toHaveBeenCalledWith("No mode found for slug: no-such-mode")
	})

	it("getDescription は値/未定義(?? '')/未検出('') を扱う", () => {
		expect(getDescription("custom-x", [fullCustom])).toBe("custom description")
		expect(getDescription("custom-min", [minimalCustom])).toBe("")
		expect(getDescription("no-such-mode")).toBe("")
	})

	it("getWhenToUse は値/未定義(?? '')/未検出('') を扱う", () => {
		expect(getWhenToUse("custom-x", [fullCustom])).toBe("custom whenToUse")
		expect(getWhenToUse("custom-min", [minimalCustom])).toBe("")
		expect(getWhenToUse("no-such-mode")).toBe("")
	})

	it("getCustomInstructions は値/未定義(?? '')/未検出('') を扱う", () => {
		expect(getCustomInstructions("custom-x", [fullCustom])).toBe("custom instructions")
		expect(getCustomInstructions("custom-min", [minimalCustom])).toBe("")
		expect(getCustomInstructions("no-such-mode")).toBe("")
	})
})

describe("defaultPrompts", () => {
	it("組み込みモードごとのプロンプト既定を凍結して保持", () => {
		expect(Object.isFrozen(defaultPrompts)).toBe(true)
		const code = modes.find((m) => m.slug === "code")!
		expect(defaultPrompts.code?.roleDefinition).toBe(code.roleDefinition)
	})
})
