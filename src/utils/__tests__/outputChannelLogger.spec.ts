import * as vscode from "vscode"

import { createOutputChannelLogger, createDualLogger } from "../outputChannelLogger"

// Mock VSCode output channel
const mockOutputChannel = {
	appendLine: vitest.fn(),
} as unknown as vscode.OutputChannel

describe("outputChannelLogger", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
		// Clear console.log mock if it exists
		if (vitest.isMockFunction(console.log)) {
			;(console.log as any).mockClear()
		}
	})

	describe("createOutputChannelLogger", () => {
		it("should log strings to output channel", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("test message")

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("test message")
		})

		it("should log null values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(null)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("null")
		})

		it("should log undefined values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(undefined)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("undefined")
		})

		it("should log Error objects with stack trace", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const error = new Error("test error")
			logger(error)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error: test error"))
		})

		it("should log objects as JSON", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const obj = { key: "value", number: 42 }
			logger(obj)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(JSON.stringify(obj, expect.any(Function), 2))
		})

		it("should log an Error without a stack trace (|| '' 分岐)", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const error = new Error("no stack here")
			delete error.stack

			logger(error)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Error: no stack here\n")
		})

		it("should format bigint / function / symbol values via the JSON replacer", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const named = function myFn() {}
			const anon = [function () {}][0] // name === "" → "anonymous"
			const obj = {
				big: 10n,
				named,
				anon,
				sym: Symbol("s"),
			}

			logger(obj)

			const out = vitest.mocked(mockOutputChannel.appendLine).mock.calls.at(-1)![0]
			expect(out).toContain("BigInt(10)")
			expect(out).toContain("Function: myFn")
			expect(out).toContain("Function: anonymous")
			expect(out).toContain("Symbol(s)")
		})

		it("should fall back to a placeholder for non-serializable (circular) objects", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			// 循環参照は replacer では救えず JSON.stringify が投げる → catch のフォールバック経路。
			const circular: Record<string, unknown> = { name: "loop" }
			circular.self = circular

			logger(circular)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[Non-serializable object:"),
			)
		})

		it("should handle multiple arguments", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("message", 42, { key: "value" })

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(3)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
				3,
				JSON.stringify({ key: "value" }, expect.any(Function), 2),
			)
		})
	})

	describe("createDualLogger", () => {
		it("should log to both output channel and console", () => {
			const consoleSpy = vitest.spyOn(console, "log").mockImplementation(() => {})
			const outputChannelLogger = createOutputChannelLogger(mockOutputChannel)
			const dualLogger = createDualLogger(outputChannelLogger)

			dualLogger("test message", 42)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(2)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "test message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(consoleSpy).toHaveBeenCalledWith("test message", 42)

			consoleSpy.mockRestore()
		})
	})
})
