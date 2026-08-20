// npx vitest run core/config/__tests__/customModesMerge.spec.ts

import type { ModeConfig } from "@openai-agent/types"

import { mergeCustomModes } from "../customModesMerge"

const mode = (slug: string, overrides: Partial<ModeConfig> = {}): ModeConfig =>
	({ slug, name: slug, roleDefinition: `role ${slug}`, groups: [], ...overrides }) as ModeConfig

describe("mergeCustomModes", () => {
	it("puts project modes before global modes", () => {
		const merged = mergeCustomModes([mode("a")], [mode("b")])

		expect(merged.map((m) => m.slug)).toEqual(["a", "b"])
	})

	it("lets a project mode win over a global mode with the same slug", () => {
		const merged = mergeCustomModes(
			[mode("shared", { name: "from project" })],
			[mode("shared", { name: "from global" })],
		)

		expect(merged).toHaveLength(1)
		expect(merged[0].name).toBe("from project")
		expect(merged[0].source).toBe("project")
	})

	it("stamps source from the file the mode came from, overriding what the file claims", () => {
		// `.agentmodes` に `source: global` と書かれていても project 扱いにする。
		const merged = mergeCustomModes([mode("p", { source: "global" })], [mode("g", { source: "project" })])

		expect(merged.find((m) => m.slug === "p")?.source).toBe("project")
		expect(merged.find((m) => m.slug === "g")?.source).toBe("global")
	})

	it("drops later duplicates within the project list", () => {
		const merged = mergeCustomModes([mode("dup", { name: "first" }), mode("dup", { name: "second" })], [])

		expect(merged).toHaveLength(1)
		expect(merged[0].name).toBe("first")
	})

	it("drops later duplicates within the global list", () => {
		const merged = mergeCustomModes([], [mode("dup", { name: "first" }), mode("dup", { name: "second" })])

		expect(merged).toHaveLength(1)
		expect(merged[0].name).toBe("first")
	})

	it("does not mutate the inputs", () => {
		const project = [mode("a", { source: "global" })]
		const global = [mode("b")]

		mergeCustomModes(project, global)

		expect(project[0].source).toBe("global")
		expect(global[0].source).toBeUndefined()
	})

	it("returns an empty list when both sides are empty", () => {
		expect(mergeCustomModes([], [])).toEqual([])
	})
})
