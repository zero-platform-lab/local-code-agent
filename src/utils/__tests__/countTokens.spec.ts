// npx vitest run utils/__tests__/countTokens.spec.ts
//
// countTokens は worker pool 越しに tiktoken を回す。pool はモジュール状態なので、
// 各シナリオは vi.resetModules + 動的 import で初期状態から検証する。

import type { ContentBlockParam } from "@openai-agent/types"
import { describe, it, expect, beforeEach, vi } from "vitest"

const { poolMock, execMock, tiktokenMock } = vi.hoisted(() => {
	const execMock = vi.fn()
	return {
		execMock,
		poolMock: vi.fn((_scriptPath: string, _opts: unknown) => ({ exec: execMock })),
		tiktokenMock: vi.fn(async () => 7),
	}
})

vi.mock("workerpool", () => ({ default: { pool: poolMock }, pool: poolMock }))
vi.mock("../tiktoken", () => ({ tiktoken: tiktokenMock }))

const CONTENT: ContentBlockParam[] = [{ type: "text", text: "hi" }]

async function freshCountTokens() {
	vi.resetModules()
	return (await import("../countTokens")).countTokens
}

describe("countTokens", () => {
	beforeEach(() => {
		poolMock.mockClear()
		execMock.mockReset()
		tiktokenMock.mockClear()
	})

	it("useWorker 既定では pool を遅延生成し、worker の結果を返す", async () => {
		execMock.mockResolvedValue({ success: true, count: 42 })
		const countTokens = await freshCountTokens()

		const result = await countTokens(CONTENT)

		expect(result).toBe(42)
		expect(poolMock).toHaveBeenCalledTimes(1)
		// worker スクリプトのパスと制約オプションを固定する。
		const [scriptPath, opts] = poolMock.mock.calls[0]
		expect(String(scriptPath)).toContain("/workers/countTokens.js")
		expect(opts).toEqual({ maxWorkers: 1, maxQueueSize: 10 })
		expect(execMock).toHaveBeenCalledWith("countTokens", [CONTENT])
		expect(tiktokenMock).not.toHaveBeenCalled()
	})

	it("2 回目の呼び出しでは pool を再生成しない", async () => {
		execMock.mockResolvedValue({ success: true, count: 1 })
		const countTokens = await freshCountTokens()

		await countTokens(CONTENT)
		await countTokens(CONTENT)

		expect(poolMock).toHaveBeenCalledTimes(1)
	})

	it("useWorker:false なら pool を作らず直接 tiktoken を使う", async () => {
		const countTokens = await freshCountTokens()

		const result = await countTokens(CONTENT, { useWorker: false })

		expect(result).toBe(7)
		expect(poolMock).not.toHaveBeenCalled()
		expect(tiktokenMock).toHaveBeenCalledWith(CONTENT)
	})

	it("worker が success:false を返したら tiktoken にフォールバックする", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		execMock.mockResolvedValue({ success: false, error: "worker failed" })
		const countTokens = await freshCountTokens()

		const result = await countTokens(CONTENT)

		expect(result).toBe(7)
		expect(tiktokenMock).toHaveBeenCalledWith(CONTENT)
		expect(errorSpy).toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("worker が例外を投げたら pool を無効化し、以降は tiktoken を使い続ける", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		execMock.mockRejectedValue(new Error("pool crashed"))
		const countTokens = await freshCountTokens()

		// 1 回目: exec 失敗 → catch で pool=null → tiktoken
		const first = await countTokens(CONTENT)
		expect(first).toBe(7)
		expect(poolMock).toHaveBeenCalledTimes(1)

		// 2 回目: pool は null（undefined ではない）なので再生成されず、そのまま tiktoken
		const second = await countTokens(CONTENT)
		expect(second).toBe(7)
		expect(poolMock).toHaveBeenCalledTimes(1)
		expect(execMock).toHaveBeenCalledTimes(1)

		errorSpy.mockRestore()
	})
})
