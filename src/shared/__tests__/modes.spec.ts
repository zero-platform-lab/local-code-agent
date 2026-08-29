// npx vitest run shared/__tests__/modes.spec.ts

import type { PromptComponent } from "@openai-agent/types"

// Mock setup must come before imports
vi.mock("vscode")

vi.mock("../../core/prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

import { getFullModeDetails, modes, getModeSelection } from "../modes"
import { isToolAllowedForMode } from "../../core/tools/validateToolUse"
import { addCustomInstructions } from "../../core/prompts/sections/custom-instructions"

describe("isToolAllowedForMode", () => {
	it("allows always available tools", () => {
		expect(isToolAllowedForMode("ask_followup_question", "code")).toBe(true)
		expect(isToolAllowedForMode("attempt_completion", "code")).toBe(true)
	})

	it("allows tools from the mode's groups", () => {
		expect(isToolAllowedForMode("read_file", "code")).toBe(true)
		expect(isToolAllowedForMode("write_to_file", "code")).toBe(true)
		expect(isToolAllowedForMode("execute_command", "research")).toBe(true)
	})

	it("handles non-existent modes", () => {
		expect(isToolAllowedForMode("write_to_file", "non-existent")).toBe(false)
	})

	it("respects tool requirements", () => {
		const toolRequirements = {
			write_to_file: false,
		}

		expect(isToolAllowedForMode("write_to_file", "code", toolRequirements)).toBe(false)
	})

	it("tool requirements disable even always-available tools", () => {
		expect(isToolAllowedForMode("attempt_completion", "code", { attempt_completion: false })).toBe(false)
	})

	it("allows dynamic MCP tools when the mcp group is present", () => {
		expect(isToolAllowedForMode("mcp_server_tool", "code")).toBe(true)
	})

	describe("customTools (opt-in tools)", () => {
		it("disallows customTools by default (not in includedTools)", () => {
			// "edit" is in the edit group's customTools, not tools.
			expect(isToolAllowedForMode("edit", "code")).toBe(false)
		})

		it("allows customTools when included in includedTools", () => {
			expect(isToolAllowedForMode("edit", "code", undefined, {}, ["edit"])).toBe(true)
		})

		it("allows regular tools in the same group as customTools", () => {
			expect(isToolAllowedForMode("apply_diff", "code")).toBe(true)
		})
	})
})

describe("getModeSelection", () => {
	const builtInCodeMode = modes.find((m) => m.slug === "code")!

	const promptComponentCode: PromptComponent = {
		roleDefinition: "Prompt Component Code Role",
		customInstructions: "Prompt Component Code Instructions",
	}

	test("should return built-in mode details if no overrides", () => {
		const selection = getModeSelection("code")
		expect(selection.roleDefinition).toBe(builtInCodeMode.roleDefinition)
		expect(selection.baseInstructions).toBe(builtInCodeMode.customInstructions || "")
	})

	test("should prioritize promptComponent over the built-in mode", () => {
		const selection = getModeSelection("code", promptComponentCode)
		expect(selection.roleDefinition).toBe(promptComponentCode.roleDefinition)
		expect(selection.baseInstructions).toBe(promptComponentCode.customInstructions)
	})

	test("built-in mode without customInstructions falls back to empty string", () => {
		// "code" 組み込みモードは customInstructions を持たないため、
		// built-in 経路で baseMode.customInstructions || "" の右辺（""）を踏む
		const selection = getModeSelection("code", undefined)
		expect(selection.baseInstructions).toBe("")
		expect(selection.roleDefinition).toBe(builtInCodeMode.roleDefinition)
	})

	test("falls back to the first mode for an unknown slug", () => {
		const selection = getModeSelection("non-existent")
		expect(selection.roleDefinition).toBe(modes[0].roleDefinition)
	})
})

describe("getFullModeDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(addCustomInstructions).mockResolvedValue("Combined instructions")
	})

	it("returns base mode when no overrides exist", async () => {
		const result = await getFullModeDetails("code")
		expect(result).toMatchObject({
			slug: "code",
			name: "💻 Code",
			roleDefinition:
				"You are a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
		})
	})

	it("applies prompt component overrides", async () => {
		const customModePrompts = {
			research: {
				roleDefinition: "Overridden role",
				customInstructions: "Overridden instructions",
			},
		}

		const result = await getFullModeDetails("research", customModePrompts)
		expect(result.roleDefinition).toBe("Overridden role")
		expect(result.customInstructions).toBe("Overridden instructions")
	})

	it("combines custom instructions when cwd provided", async () => {
		const options = {
			cwd: "/test/path",
			globalCustomInstructions: "Global instructions",
			language: "en",
		}

		await getFullModeDetails("research", undefined, options)

		expect(addCustomInstructions).toHaveBeenCalledWith(
			expect.any(String),
			"Global instructions",
			"/test/path",
			"research",
			{ language: "en" },
		)
	})

	it("uses empty string when cwd provided without globalCustomInstructions", async () => {
		// options.cwd はあるが globalCustomInstructions 無し → || "" の右辺を踏む
		await getFullModeDetails("research", undefined, { cwd: "/test/path" })

		expect(addCustomInstructions).toHaveBeenCalledWith(expect.any(String), "", "/test/path", "research", {
			language: undefined,
		})
	})

	it("falls back to first mode for non-existent mode", async () => {
		const result = await getFullModeDetails("non-existent")
		expect(result).toMatchObject({
			slug: modes[0].slug,
			name: modes[0].name,
		})
	})
})
