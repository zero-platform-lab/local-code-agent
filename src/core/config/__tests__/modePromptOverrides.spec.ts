// npx vitest run core/config/__tests__/modePromptOverrides.spec.ts

import type { ModeConfig } from "@openai-agent/types"

import { applyPromptOverrides } from "../modePromptOverrides"

const mode = (overrides: Partial<ModeConfig> = {}): ModeConfig =>
	({
		slug: "architect",
		name: "Architect",
		roleDefinition: "BUILT-IN ROLE",
		description: "BUILT-IN DESCRIPTION",
		whenToUse: "BUILT-IN WHEN",
		customInstructions: "BUILT-IN INSTRUCTIONS",
		groups: ["read"],
		...overrides,
	}) as ModeConfig

describe("applyPromptOverrides — no overrides", () => {
	it("returns the mode untouched when overrides are undefined", () => {
		const base = mode()

		expect(applyPromptOverrides(base, undefined)).toBe(base)
	})

	it("returns an equal mode for an empty override object", () => {
		expect(applyPromptOverrides(mode(), {})).toEqual(mode())
	})

	it("does not mutate the input mode", () => {
		const base = mode()

		applyPromptOverrides(base, { roleDefinition: "MINE" })

		expect(base.roleDefinition).toBe("BUILT-IN ROLE")
	})
})

describe("applyPromptOverrides — each overridable field", () => {
	it.each(["roleDefinition", "description", "whenToUse", "customInstructions"] as const)("replaces %s", (field) => {
		const result = applyPromptOverrides(mode(), { [field]: "MINE" })

		expect(result[field]).toBe("MINE")
	})

	it("leaves the other fields at their built-in values", () => {
		const result = applyPromptOverrides(mode(), { roleDefinition: "MINE" })

		expect(result.description).toBe("BUILT-IN DESCRIPTION")
		expect(result.whenToUse).toBe("BUILT-IN WHEN")
		expect(result.customInstructions).toBe("BUILT-IN INSTRUCTIONS")
	})

	it("applies several overrides at once", () => {
		const result = applyPromptOverrides(mode(), { roleDefinition: "R", customInstructions: "C" })

		expect(result).toMatchObject({ roleDefinition: "R", customInstructions: "C", whenToUse: "BUILT-IN WHEN" })
	})

	it("keeps fields that are not overridable, such as slug and groups", () => {
		const result = applyPromptOverrides(mode(), { roleDefinition: "MINE" })

		expect(result.slug).toBe("architect")
		expect(result.groups).toEqual(["read"])
	})
})

describe("applyPromptOverrides — falsy overrides are ignored", () => {
	it.each(["roleDefinition", "description", "whenToUse", "customInstructions"] as const)(
		"ignores an empty string for %s",
		(field) => {
			const result = applyPromptOverrides(mode(), { [field]: "" })

			expect(result[field]).toBe(mode()[field])
		},
	)

	it("ignores explicit undefined", () => {
		expect(applyPromptOverrides(mode(), { roleDefinition: undefined })).toEqual(mode())
	})
})

describe("applyPromptOverrides — redundant overrides are a no-op", () => {
	it("an override equal to the built-in value produces an equal mode", () => {
		// エクスポートが差分ではなくスナップショットなので、同じ値での上書きは観測できない。
		// これがエクスポート経路に scrub を足さない判断の根拠。
		const base = mode()

		expect(applyPromptOverrides(base, { customInstructions: base.customInstructions })).toEqual(base)
	})

	it("a redundant override mixed with a real one only shows the real change", () => {
		const base = mode()
		const result = applyPromptOverrides(base, {
			roleDefinition: "MINE",
			customInstructions: base.customInstructions,
		})

		expect(result).toEqual({ ...base, roleDefinition: "MINE" })
	})
})
