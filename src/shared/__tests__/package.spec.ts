// npx vitest run shared/__tests__/package.spec.ts

// Package はモジュール読み込み時に process.env を評価するため、
// env を書き換えてから resetModules + 動的 import で両分岐を確認する。

const ENV_KEYS = ["PKG_PUBLISHER", "PKG_NAME", "PKG_VERSION", "PKG_OUTPUT_CHANNEL", "PKG_SHA"] as const

describe("Package", () => {
	let saved: Record<string, string | undefined>

	beforeEach(() => {
		saved = {}
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k]
			delete process.env[k]
		}
		vi.resetModules()
	})

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) {
				delete process.env[k]
			} else {
				process.env[k] = saved[k]
			}
		}
		vi.resetModules()
	})

	it("env 未設定なら package.json 由来の値へフォールバック（|| 右側は使わない）", async () => {
		const { Package } = await import("../package")
		expect(typeof Package.publisher).toBe("string")
		expect(Package.publisher.length).toBeGreaterThan(0)
		expect(typeof Package.name).toBe("string")
		expect(typeof Package.version).toBe("string")
		expect(Package.outputChannel).toBe("Agent")
		expect(Package.sha).toBeUndefined()
	})

	it("env 指定時はその値で上書きする", async () => {
		process.env.PKG_PUBLISHER = "custom-pub"
		process.env.PKG_NAME = "custom-name"
		process.env.PKG_VERSION = "9.9.9"
		process.env.PKG_OUTPUT_CHANNEL = "CustomChannel"
		process.env.PKG_SHA = "abcdef0"
		const { Package } = await import("../package")
		expect(Package.publisher).toBe("custom-pub")
		expect(Package.name).toBe("custom-name")
		expect(Package.version).toBe("9.9.9")
		expect(Package.outputChannel).toBe("CustomChannel")
		expect(Package.sha).toBe("abcdef0")
	})
})
