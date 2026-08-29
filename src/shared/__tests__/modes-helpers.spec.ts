// npx vitest run shared/__tests__/modes-helpers.spec.ts

import type * as vscode from "vscode"
import type { CustomModePrompts } from "@openai-agent/types"

import {
	getToolsForMode,
	getModeBySlug,
	getModeConfig,
	getAllModes,
	getAllModesWithPrompts,
	getRoleDefinition,
	getDescription,
	getWhenToUse,
	getCustomInstructions,
	modes,
	defaultPrompts,
} from "../modes"

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
	it("組み込みモードを返す", () => {
		expect(getModeBySlug("code")?.slug).toBe("code")
		expect(getModeBySlug("research")?.slug).toBe("research")
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
	it("組み込みモードのコピーを返す", () => {
		const all = getAllModes()
		expect(all).toHaveLength(modes.length)
		expect(all).not.toBe(modes as unknown)
	})
})

describe("getAllModesWithPrompts", () => {
	const makeContext = (customModePrompts: unknown) =>
		({
			globalState: {
				get: vi.fn(async (key: string) => {
					if (key === "customModePrompts") return customModePrompts
					return undefined
				}),
			},
		}) as unknown as vscode.ExtensionContext

	it("customModePrompts のオーバーライドを適用しつつ未指定はフォールバック", async () => {
		const prompts: CustomModePrompts = { code: { roleDefinition: "overridden role" } }
		const context = makeContext(prompts)
		const result = await getAllModesWithPrompts(context)

		const code = result.find((m) => m.slug === "code")!
		expect(code.roleDefinition).toBe("overridden role")
		// whenToUse / customInstructions はオーバーライド無し → 元の値
		const builtinCode = modes.find((m) => m.slug === "code")!
		expect(code.customInstructions).toBe(builtinCode.customInstructions)
	})

	it("globalState が空でも既定値へフォールバック（|| {}）", async () => {
		const context = makeContext(undefined)
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
		const code = modes.find((m) => m.slug === "code")!
		expect(getRoleDefinition("code")).toBe(code.roleDefinition)
		expect(getRoleDefinition("no-such-mode")).toBe("")
		expect(console.warn).toHaveBeenCalledWith("No mode found for slug: no-such-mode")
	})

	it("getDescription は値/未検出('') を扱う", () => {
		const code = modes.find((m) => m.slug === "code")!
		expect(getDescription("code")).toBe(code.description)
		expect(getDescription("no-such-mode")).toBe("")
	})

	it("getWhenToUse は値/未検出('') を扱う", () => {
		const code = modes.find((m) => m.slug === "code")!
		expect(getWhenToUse("code")).toBe(code.whenToUse)
		expect(getWhenToUse("no-such-mode")).toBe("")
	})

	it("getCustomInstructions は未定義(?? '')/未検出('') を扱う", () => {
		// 組み込みモードは customInstructions を持たない → ?? "" の右辺
		expect(getCustomInstructions("code")).toBe("")
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
