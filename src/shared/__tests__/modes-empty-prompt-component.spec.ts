import type { PromptComponent } from "@openai-agent/types"

import { getModeSelection, modes } from "../modes"

// マージ規則（promptComponent 優先・欠けたフィールドは組み込みへフォールバック）を
// code で確かめる。
describe("getModeSelection with empty promptComponent", () => {
	const codeMode = modes.find((m) => m.slug === "code")!

	it("should use built-in mode values when promptComponent is undefined", () => {
		// getPromptComponent は空オブジェクトに対して undefined を返す
		const result = getModeSelection("code", undefined)

		expect(result.roleDefinition).toBe(codeMode.roleDefinition)
		// code は customInstructions を持たないので空文字に落ちる
		expect(result.baseInstructions).toBe("")
	})

	it("should use built-in mode values when promptComponent is null", () => {
		const result = getModeSelection("code", null as any)

		expect(result.roleDefinition).toBe(codeMode.roleDefinition)
		expect(result.baseInstructions).toBe("")
	})

	it("should use promptComponent when it has actual content", () => {
		const validPromptComponent: PromptComponent = {
			roleDefinition: "Custom role",
			customInstructions: "Custom instructions",
		}
		const result = getModeSelection("code", validPromptComponent)

		expect(result.roleDefinition).toBe("Custom role")
		expect(result.baseInstructions).toBe("Custom instructions")
	})

	it("should merge promptComponent with built-in mode when it has partial content", () => {
		// customInstructions だけを持つ promptComponent
		const partialPromptComponent: PromptComponent = {
			customInstructions: "Only custom instructions",
		}
		const result = getModeSelection("code", partialPromptComponent)

		expect(result.roleDefinition).toBe(codeMode.roleDefinition) // 組み込みへフォールバック
		expect(result.baseInstructions).toBe("Only custom instructions") // promptComponent を使う
	})

	it("should merge promptComponent with built-in mode when it only has roleDefinition", () => {
		// roleDefinition だけを持つ promptComponent
		const partialPromptComponent: PromptComponent = {
			roleDefinition: "Custom code role",
		}
		const result = getModeSelection("code", partialPromptComponent)

		expect(result.roleDefinition).toBe("Custom code role") // promptComponent を使う
		expect(result.baseInstructions).toBe("") // 組み込みへフォールバック（code は未設定）
	})

	it("should handle promptComponent with both roleDefinition and customInstructions", () => {
		const fullPromptComponent: PromptComponent = {
			roleDefinition: "Full custom role",
			customInstructions: "Full custom instructions",
		}
		const result = getModeSelection("code", fullPromptComponent)

		expect(result.roleDefinition).toBe("Full custom role")
		expect(result.baseInstructions).toBe("Full custom instructions")
	})

	it("should fall back to default mode when built-in mode is not found", () => {
		const defaultMode = modes[0]

		const partialPromptComponent: PromptComponent = {
			customInstructions: "Custom instructions for unknown mode",
		}
		const result = getModeSelection("non-existent-mode", partialPromptComponent)

		expect(result.roleDefinition).toBe(defaultMode.roleDefinition)
		expect(result.baseInstructions).toBe("Custom instructions for unknown mode")
	})
})
