// npx vitest run utils/__tests__/errors.spec.ts

import { describe, it, expect } from "vitest"

import { OrganizationAllowListViolationError } from "../errors"

describe("OrganizationAllowListViolationError", () => {
	it("Error を継承し、message をそのまま保持する", () => {
		const err = new OrganizationAllowListViolationError("model foo is not allowed")

		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(OrganizationAllowListViolationError)
		expect(err.message).toBe("model foo is not allowed")
	})

	it("throw / catch を跨いでも識別できる（instanceof が保たれる）", () => {
		try {
			throw new OrganizationAllowListViolationError("blocked")
		} catch (e) {
			expect(e).toBeInstanceOf(OrganizationAllowListViolationError)
			expect((e as Error).message).toBe("blocked")
		}
	})

	it("空 message も受け付ける（境界）", () => {
		const err = new OrganizationAllowListViolationError("")
		expect(err.message).toBe("")
	})
})
