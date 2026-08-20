import { describe, it, expect, vi } from "vitest"

import { makeNextChunkWithAbort } from "../makeNextChunkWithAbort"

describe("makeNextChunkWithAbort", () => {
	it("controller が無ければ素の iterator.next() をそのまま返す", async () => {
		const iterator = { next: vi.fn(async () => ({ done: true, value: undefined })) }
		const next = makeNextChunkWithAbort(iterator as never, () => undefined)

		await expect(next()).resolves.toEqual({ done: true, value: undefined })
		expect(iterator.next).toHaveBeenCalledTimes(1)
	})

	it("controller があり未 abort なら chunk を返す", async () => {
		const controller = new AbortController()
		const iterator = { next: async () => ({ done: false, value: "X" }) }
		const next = makeNextChunkWithAbort(iterator as never, () => controller)

		await expect(next()).resolves.toEqual({ done: false, value: "X" })
	})

	it("呼び出し時点で既に abort 済みなら即 reject する", async () => {
		const controller = new AbortController()
		controller.abort()
		// next() は解決しない（race が abort 側で reject するのを確認）
		const iterator = { next: () => new Promise<never>(() => {}) }
		const next = makeNextChunkWithAbort(iterator as never, () => controller)

		await expect(next()).rejects.toThrow("Request cancelled by user")
	})

	it("待機中に abort されたら race が reject する", async () => {
		const controller = new AbortController()
		const iterator = { next: () => new Promise<never>(() => {}) }
		const next = makeNextChunkWithAbort(iterator as never, () => controller)

		const pending = next()
		controller.abort()

		await expect(pending).rejects.toThrow("Request cancelled by user")
	})

	it("chunk が正常に解決したら abort リスナを外す（長ストリームでの蓄積を防ぐ）", async () => {
		const controller = new AbortController()
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
		const iterator = { next: async () => ({ done: false, value: "X" }) }
		const next = makeNextChunkWithAbort(iterator as never, () => controller)

		await next()
		// nextPromise.finally は microtask なので settle を待つ
		await new Promise((r) => setTimeout(r, 0))

		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	it("controller は呼び出しごとに取り直す（途中差し替えに追従）", async () => {
		const iterator = { next: vi.fn(async () => ({ done: false, value: "Y" })) }
		// 1 回目は controller 無し、2 回目は未 abort の controller を返す
		const controllers: Array<AbortController | undefined> = [undefined, new AbortController()]
		let call = 0
		const next = makeNextChunkWithAbort(iterator as never, () => controllers[call++])

		await expect(next()).resolves.toEqual({ done: false, value: "Y" })
		await expect(next()).resolves.toEqual({ done: false, value: "Y" })
		expect(iterator.next).toHaveBeenCalledTimes(2)
	})
})
