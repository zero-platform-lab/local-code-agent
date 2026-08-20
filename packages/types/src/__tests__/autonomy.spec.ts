// npx vitest run src/__tests__/autonomy.spec.ts
import { describe, it, expect } from "vitest"

import {
	autonomyModes,
	AUTONOMY_MODE_CYCLE,
	AUTONOMY_PRESETS,
	DEFAULT_AUTONOMY_MODE,
	DEFAULT_DENIED_COMMANDS,
	nextAutonomyMode,
	isReadOnlyAutonomyMode,
	type AutonomyMode,
} from "../autonomy.js"

describe("autonomy presets", () => {
	it("defaults to manual (safest)", () => {
		expect(DEFAULT_AUTONOMY_MODE).toBe("manual")
		expect(AUTONOMY_PRESETS.manual.autoApprovalEnabled).toBe(false)
	})

	it("manual asks for everything", () => {
		const p = AUTONOMY_PRESETS.manual
		expect(Object.values(p).every((v) => v === false)).toBe(true)
	})

	it("autoEdit auto-approves edits but NOT command execution", () => {
		const p = AUTONOMY_PRESETS.autoEdit
		expect(p.autoApprovalEnabled).toBe(true)
		expect(p.alwaysAllowReadOnly).toBe(true)
		expect(p.alwaysAllowWrite).toBe(true)
		expect(p.alwaysAllowExecute).toBe(false)
	})

	it("auto enables execution (destructive still blocked by deniedCommands, not here)", () => {
		const p = AUTONOMY_PRESETS.auto
		expect(p.autoApprovalEnabled).toBe(true)
		expect(p.alwaysAllowExecute).toBe(true)
	})

	it("plan is read-only: reads auto-approved, writes/commands off", () => {
		const p = AUTONOMY_PRESETS.plan
		expect(p.autoApprovalEnabled).toBe(true)
		expect(p.alwaysAllowReadOnly).toBe(true)
		expect(p.alwaysAllowWrite).toBe(false)
		expect(p.alwaysAllowExecute).toBe(false)
	})

	it("isReadOnlyAutonomyMode flags only plan", () => {
		expect(isReadOnlyAutonomyMode("plan")).toBe(true)
		expect(isReadOnlyAutonomyMode("manual")).toBe(false)
		expect(isReadOnlyAutonomyMode("autoEdit")).toBe(false)
		expect(isReadOnlyAutonomyMode("auto")).toBe(false)
		expect(isReadOnlyAutonomyMode(undefined)).toBe(false)
	})

	it("escalation is monotonic: manual ⊆ autoEdit ⊆ auto", () => {
		const flags = Object.keys(AUTONOMY_PRESETS.manual) as (keyof (typeof AUTONOMY_PRESETS)["manual"])[]
		for (const flag of flags) {
			const seq = [AUTONOMY_PRESETS.manual[flag], AUTONOMY_PRESETS.autoEdit[flag], AUTONOMY_PRESETS.auto[flag]]
			// Once a flag turns true along the sequence, it never turns back false.
			const firstTrue = seq.indexOf(true)
			if (firstTrue !== -1) {
				expect(seq.slice(firstTrue).every(Boolean)).toBe(true)
			}
		}
	})

	it("presets never touch command policy or outside-workspace escalations", () => {
		// AutonomyPreset must not include these keys — they stay under explicit user control.
		const forbidden = [
			"allowedCommands",
			"deniedCommands",
			"alwaysAllowReadOnlyOutsideWorkspace",
			"alwaysAllowWriteOutsideWorkspace",
			"alwaysAllowWriteProtected",
		]
		for (const mode of autonomyModes) {
			for (const key of forbidden) {
				expect(Object.prototype.hasOwnProperty.call(AUTONOMY_PRESETS[mode], key)).toBe(false)
			}
		}
	})
})

describe("nextAutonomyMode", () => {
	it("cycles through the defined order and wraps", () => {
		const order = [...AUTONOMY_MODE_CYCLE]
		let current: AutonomyMode = order[0] ?? DEFAULT_AUTONOMY_MODE
		const visited: AutonomyMode[] = [current]
		for (let i = 0; i < order.length; i++) {
			current = nextAutonomyMode(current)
			visited.push(current)
		}
		// After N steps we should be back to the start, having visited each once.
		expect(visited[order.length]).toBe(order[0])
		expect(new Set(visited.slice(0, order.length))).toEqual(new Set(order))
	})

	it("treats undefined as before-the-start (yields the first mode)", () => {
		expect(nextAutonomyMode(undefined)).toBe(AUTONOMY_MODE_CYCLE[0])
	})
})

describe("default denied commands", () => {
	it("blocks the classic destructive commands", () => {
		for (const needle of ["rm -rf", "sudo", "dd", "mkfs", "git push --force"]) {
			expect(DEFAULT_DENIED_COMMANDS).toContain(needle)
		}
	})
})
