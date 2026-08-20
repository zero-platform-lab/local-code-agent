import { describe, it, expect } from "vitest"

import { formatCostBreakdown, getCostBreakdownIfNeeded } from "../costFormatting"

const labels = { own: "Own", subtasks: "Subtasks" }

describe("formatCostBreakdown", () => {
	it("formats a basic breakdown", () => {
		expect(formatCostBreakdown(1, 0.5, labels)).toBe("Own: $1.00 + Subtasks: $0.50")
	})

	it("formats zero costs", () => {
		expect(formatCostBreakdown(0, 0, labels)).toBe("Own: $0.00 + Subtasks: $0.00")
	})

	it("rounds to two decimal places", () => {
		expect(formatCostBreakdown(1.999, 0.001, labels)).toBe("Own: $2.00 + Subtasks: $0.00")
	})

	// --- Mutation kills ---
	it("includes ownCost in the output (mutation: swapping ownCost with childrenCost)", () => {
		const result = formatCostBreakdown(3, 7, labels)
		expect(result).toContain("$3.00")
		expect(result).toContain("$7.00")
		expect(result).toBe("Own: $3.00 + Subtasks: $7.00")
	})

	it("uses the provided label strings", () => {
		const ja = { own: "自分", subtasks: "サブタスク" }
		expect(formatCostBreakdown(1, 2, ja)).toBe("自分: $1.00 + サブタスク: $2.00")
	})
})

describe("getCostBreakdownIfNeeded", () => {
	it("returns undefined when costs is undefined", () => {
		expect(getCostBreakdownIfNeeded(undefined, labels)).toBeUndefined()
	})

	it("returns undefined when childrenCost is 0", () => {
		expect(getCostBreakdownIfNeeded({ ownCost: 1, childrenCost: 0 }, labels)).toBeUndefined()
	})

	it("returns undefined when childrenCost is negative", () => {
		expect(getCostBreakdownIfNeeded({ ownCost: 1, childrenCost: -1 }, labels)).toBeUndefined()
	})

	it("returns breakdown string when childrenCost > 0", () => {
		expect(getCostBreakdownIfNeeded({ ownCost: 1, childrenCost: 0.5 }, labels)).toBe("Own: $1.00 + Subtasks: $0.50")
	})

	// --- Mutation kill: ensure the boundary is strictly > 0, not >= 0 ---
	it("returns undefined for childrenCost exactly 0 (boundary)", () => {
		expect(getCostBreakdownIfNeeded({ ownCost: 5, childrenCost: 0 }, labels)).toBeUndefined()
	})

	it("returns breakdown for tiny positive childrenCost (boundary)", () => {
		const result = getCostBreakdownIfNeeded({ ownCost: 0, childrenCost: 0.01 }, labels)
		expect(result).toBe("Own: $0.00 + Subtasks: $0.01")
	})
})
