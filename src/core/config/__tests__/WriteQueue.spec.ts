// npx vitest run core/config/__tests__/WriteQueue.spec.ts

import { WriteQueue } from "../WriteQueue"

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((r) => (resolve = r))
	return { promise, resolve }
}

describe("WriteQueue", () => {
	it("runs a single operation and reports an empty queue afterwards", async () => {
		const queue = new WriteQueue()
		const op = vi.fn(async () => {})

		await queue.enqueue(op)

		expect(op).toHaveBeenCalledOnce()
		expect(queue.size).toBe(0)
		expect(queue.isDraining).toBe(false)
	})

	it("runs operations in FIFO order, never overlapping", async () => {
		const queue = new WriteQueue()
		const order: string[] = []
		const slow = async (label: string) => {
			order.push(`${label}:start`)
			await Promise.resolve()
			order.push(`${label}:end`)
		}

		const first = queue.enqueue(() => slow("a"))
		const second = queue.enqueue(() => slow("b"))
		await Promise.all([first, second])

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
	})

	it("drains work enqueued by a later caller while the first drain is still running", async () => {
		const queue = new WriteQueue()
		const gate = deferred()
		const second = vi.fn(async () => {})

		const draining = queue.enqueue(async () => {
			await gate.promise
		})
		// 2 本目は drain 中に積まれるので、1 本目の drain ループが拾う。
		await queue.enqueue(second)

		expect(second).not.toHaveBeenCalled()
		gate.resolve()
		await draining

		expect(second).toHaveBeenCalledOnce()
		expect(queue.size).toBe(0)
	})

	it("does not wait for the operation when another drain is already running", async () => {
		// この性質が CustomModesManager の再入（enqueue 内から getCustomModesFilePath →
		// enqueue）を成立させている。待つ実装にするとデッドロックする。
		const queue = new WriteQueue()
		const gate = deferred()
		let reentrantRan = false

		const draining = queue.enqueue(async () => {
			// 操作の中から積む。ここで待ってしまうと外側が終わらず永久に進まない。
			await queue.enqueue(async () => {
				reentrantRan = true
			})
			// 積んだだけで戻ってきている。
			expect(reentrantRan).toBe(false)
			gate.resolve()
		})

		await gate.promise
		await draining

		expect(reentrantRan).toBe(true)
	})

	it("keeps draining after an operation throws", async () => {
		const queue = new WriteQueue()
		const after = vi.fn(async () => {})

		const draining = queue.enqueue(async () => {
			throw new Error("boom")
		})
		await queue.enqueue(after)

		await expect(draining).rejects.toThrow("boom")
		// 失敗しても drain フラグは戻るので、次の enqueue が自分でループを回せる。
		expect(queue.isDraining).toBe(false)
		await queue.enqueue(async () => {})
		expect(after).toHaveBeenCalledOnce()
	})

	it("reports isDraining while an operation is in flight", async () => {
		const queue = new WriteQueue()
		const gate = deferred()

		const draining = queue.enqueue(() => gate.promise)
		expect(queue.isDraining).toBe(true)

		gate.resolve()
		await draining
		expect(queue.isDraining).toBe(false)
	})

	it("drain() returns immediately (no-op) when there is nothing pending", async () => {
		// enqueue は必ず push してから drain を呼ぶので、公開 API 経由では
		// 「pending が空のまま drain に入る」ことは起きない。しかし drain の防御ガード
		// (`this.draining || this.pending.length === 0` の右側) が空キューを弾くことは
		// 直接呼び出しで固定できる。守りたい不変条件は「空の drain は何もせず、状態を汚さない」。
		const queue = new WriteQueue()

		await expect((queue as unknown as { drain(): Promise<void> }).drain()).resolves.toBeUndefined()

		expect(queue.isDraining).toBe(false)
		expect(queue.size).toBe(0)
	})
})
