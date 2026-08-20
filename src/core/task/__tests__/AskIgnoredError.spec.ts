// npx vitest run core/task/__tests__/AskIgnoredError.spec.ts

import { describe, it, expect } from "vitest"

import { AskIgnoredError } from "../AskIgnoredError"

describe("AskIgnoredError", () => {
	it("reason 付きなら message に理由を含める", () => {
		const err = new AskIgnoredError("superseded")

		expect(err).toBeInstanceOf(AskIgnoredError)
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("AskIgnoredError")
		expect(err.message).toBe("Ask ignored: superseded")
	})

	it("reason 無しなら既定文言になる", () => {
		const err = new AskIgnoredError()

		expect(err.message).toBe("Ask ignored")
		expect(err.name).toBe("AskIgnoredError")
	})

	it("catch 節で instanceof が効く（prototype chain を維持している）", () => {
		try {
			throw new AskIgnoredError("x")
		} catch (e) {
			expect(e instanceof AskIgnoredError).toBe(true)
		}
	})
})
