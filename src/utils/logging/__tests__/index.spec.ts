// npx vitest run utils/logging/__tests__/index.spec.ts

import { describe, it, expect, afterEach, vi } from "vitest"

describe("logging/index default logger", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.resetModules()
	})

	it("NODE_ENV=test では CompactLogger インスタンスを公開する", async () => {
		vi.stubEnv("NODE_ENV", "test")
		vi.resetModules()

		const { logger } = await import("../index")
		const { CompactLogger } = await import("../CompactLogger")

		expect(logger).toBeInstanceOf(CompactLogger)
	})

	it("非 test 環境では no-op logger を公開する", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.resetModules()

		const { logger } = await import("../index")
		const { CompactLogger } = await import("../CompactLogger")

		expect(logger).not.toBeInstanceOf(CompactLogger)

		// すべてのメソッドが副作用なく呼べる（no-op）。
		expect(logger.debug("x")).toBeUndefined()
		expect(logger.info("x")).toBeUndefined()
		expect(logger.warn("x")).toBeUndefined()
		expect(logger.error("x")).toBeUndefined()
		expect(logger.fatal("x")).toBeUndefined()
		expect(logger.close()).toBeUndefined()

		// child は自分自身（no-op logger）を返す。
		expect(logger.child({})).toBe(logger)
	})
})
