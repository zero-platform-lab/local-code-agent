// npx vitest run workers/__tests__/countTokens.spec.ts
//
// countTokens ワーカーの本体は非公開関数。workerpool.worker() に登録される関数を
// 捕まえて直接叩き、境界で落ちないことを固定する。
// 不変条件:
//   - 成功時は { success: true, count } を返す
//   - tiktoken が Error を投げたら message を、Error 以外を投げたら "Unknown error" を
//     載せた失敗結果を返す（例外を外へ漏らさない）

import { describe, it, expect, vi, beforeEach } from "vitest"
import { countTokensResultSchema, type CountTokensResult } from "../types"

const mocks = vi.hoisted(() => ({
	worker: vi.fn((_registry: Record<string, unknown>) => undefined),
	tiktoken: vi.fn(async (..._args: unknown[]) => 0),
}))

// workerpool は default import される CJS モジュール。default と名前付き両方を用意しておく。
vi.mock("workerpool", () => ({
	default: { worker: mocks.worker },
	worker: mocks.worker,
}))

vi.mock("../../utils/tiktoken", () => ({ tiktoken: mocks.tiktoken }))

type CountTokensFn = (content: unknown[]) => Promise<CountTokensResult>

let countTokens: CountTokensFn

beforeEach(async () => {
	vi.clearAllMocks()
	vi.resetModules()
	mocks.tiktoken.mockResolvedValue(0)
	await import("../countTokens")
	// import 副作用で worker() に登録された countTokens を取り出す
	const registry = mocks.worker.mock.calls[0][0] as { countTokens: CountTokensFn }
	countTokens = registry.countTokens
})

describe("countTokens ワーカー", () => {
	it("import 時に workerpool.worker へ countTokens を 1 度だけ登録する", () => {
		expect(mocks.worker).toHaveBeenCalledTimes(1)
		expect(typeof countTokens).toBe("function")
	})

	it("成功時は count を載せて返す（結果はスキーマに適合する）", async () => {
		mocks.tiktoken.mockResolvedValue(42)

		const result = await countTokens([{ type: "text", text: "hi" }])

		expect(mocks.tiktoken).toHaveBeenCalledWith([{ type: "text", text: "hi" }])
		expect(result).toEqual({ success: true, count: 42 })
		// ワーカーの戻り値は必ず境界スキーマを満たす（呼び出し側の parse が失敗しない）
		expect(countTokensResultSchema.parse(result)).toEqual(result)
	})

	it("Error が投げられたら message を失敗結果に載せる（結果はスキーマに適合する）", async () => {
		mocks.tiktoken.mockRejectedValue(new Error("encode failed"))

		const result = await countTokens([])

		expect(result).toEqual({ success: false, error: "encode failed" })
		expect(countTokensResultSchema.parse(result)).toEqual(result)
	})

	it("Error 以外が投げられたら Unknown error にフォールバックする", async () => {
		mocks.tiktoken.mockRejectedValue("just a string")

		const result = await countTokens([])

		expect(result).toEqual({ success: false, error: "Unknown error" })
		expect(countTokensResultSchema.parse(result)).toEqual(result)
	})
})
