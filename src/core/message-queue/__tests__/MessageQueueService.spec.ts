// npx vitest run core/message-queue/__tests__/MessageQueueService.spec.ts

import { MessageQueueService } from "../MessageQueueService"

describe("MessageQueueService", () => {
	let service: MessageQueueService

	beforeEach(() => {
		service = new MessageQueueService()
	})

	afterEach(() => {
		service.dispose()
	})

	describe("addMessage", () => {
		it("空文字かつ画像なしでは何も積まず undefined を返す（無効入力を弾く不変条件）", () => {
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const result = service.addMessage("")

			expect(result).toBeUndefined()
			expect(service.messages).toHaveLength(0)
			// 無効入力では stateChanged を発火しない
			expect(changed).not.toHaveBeenCalled()
		})

		it("空文字かつ空配列の画像でも undefined（images?.length が 0）", () => {
			const result = service.addMessage("", [])
			expect(result).toBeUndefined()
			expect(service.isEmpty()).toBe(true)
		})

		it("テキストがあれば積まれ、id/timestamp が付与される", () => {
			const before = Date.now()
			const msg = service.addMessage("hello")
			const after = Date.now()

			expect(msg).toBeDefined()
			expect(msg!.text).toBe("hello")
			expect(typeof msg!.id).toBe("string")
			expect(msg!.id.length).toBeGreaterThan(0)
			expect(msg!.timestamp).toBeGreaterThanOrEqual(before)
			expect(msg!.timestamp).toBeLessThanOrEqual(after)
			expect(msg!.images).toBeUndefined()
			expect(service.messages).toHaveLength(1)
		})

		it('テキストが空でも画像があれば積む（境界: text="" / images=[url]）', () => {
			const msg = service.addMessage("", ["data:image/png;base64,AAAA"])
			expect(msg).toBeDefined()
			expect(msg!.text).toBe("")
			expect(msg!.images).toEqual(["data:image/png;base64,AAAA"])
		})

		it("追加ごとに stateChanged が現在のキュー全体を伴って発火する", () => {
			const changed = vi.fn()
			service.on("stateChanged", changed)

			service.addMessage("a")
			service.addMessage("b")

			expect(changed).toHaveBeenCalledTimes(2)
			// 最後の呼び出しは 2 件になっている
			const lastArg = changed.mock.calls[1][0]
			expect(lastArg.map((m: any) => m.text)).toEqual(["a", "b"])
		})
	})

	describe("順序保全 (FIFO)", () => {
		it("dequeue は積んだ順に先頭から取り出す", () => {
			service.addMessage("first")
			service.addMessage("second")
			service.addMessage("third")

			expect(service.dequeueMessage()!.text).toBe("first")
			expect(service.dequeueMessage()!.text).toBe("second")
			expect(service.dequeueMessage()!.text).toBe("third")
		})

		it("messages は挿入順を保持する", () => {
			service.addMessage("1")
			service.addMessage("2")
			expect(service.messages.map((m) => m.text)).toEqual(["1", "2"])
		})

		it("空キューの dequeue は undefined を返し、それでも stateChanged を発火する", () => {
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const result = service.dequeueMessage()

			expect(result).toBeUndefined()
			expect(changed).toHaveBeenCalledTimes(1)
			expect(changed.mock.calls[0][0]).toEqual([])
		})
	})

	describe("removeMessage", () => {
		it("存在する id を消すと true を返し、その要素だけ消える", () => {
			const a = service.addMessage("a")!
			const b = service.addMessage("b")!
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const ok = service.removeMessage(a.id)

			expect(ok).toBe(true)
			expect(service.messages.map((m) => m.id)).toEqual([b.id])
			expect(changed).toHaveBeenCalledTimes(1)
		})

		it("未知の id では false を返し、キューも stateChanged も変化しない", () => {
			service.addMessage("a")
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const ok = service.removeMessage("does-not-exist")

			expect(ok).toBe(false)
			expect(service.messages).toHaveLength(1)
			expect(changed).not.toHaveBeenCalled()
		})
	})

	describe("updateMessage", () => {
		it("存在する id を更新すると true・text/images/timestamp が置き換わる", () => {
			const a = service.addMessage("old", ["img-old"])!
			const originalTs = a.timestamp
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const ok = service.updateMessage(a.id, "new", ["img-new"])

			expect(ok).toBe(true)
			const updated = service.messages[0]
			expect(updated.text).toBe("new")
			expect(updated.images).toEqual(["img-new"])
			expect(updated.timestamp).toBeGreaterThanOrEqual(originalTs)
			expect(changed).toHaveBeenCalledTimes(1)
		})

		it("images を省略すると images は undefined に上書きされる", () => {
			const a = service.addMessage("t", ["img"])!
			service.updateMessage(a.id, "t2")
			expect(service.messages[0].images).toBeUndefined()
		})

		it("未知の id では false を返し、何も変化しない", () => {
			service.addMessage("a")
			const changed = vi.fn()
			service.on("stateChanged", changed)

			const ok = service.updateMessage("nope", "x")

			expect(ok).toBe(false)
			expect(service.messages[0].text).toBe("a")
			expect(changed).not.toHaveBeenCalled()
		})
	})

	describe("isEmpty", () => {
		it("初期状態は空", () => {
			expect(service.isEmpty()).toBe(true)
		})

		it("積むと空でなくなる", () => {
			service.addMessage("x")
			expect(service.isEmpty()).toBe(false)
		})
	})

	describe("dispose", () => {
		it("キューを空にしリスナーを解除する", () => {
			const changed = vi.fn()
			service.on("stateChanged", changed)
			service.addMessage("x")
			changed.mockClear()

			service.dispose()

			expect(service.isEmpty()).toBe(true)
			// dispose 後は購読が切れているので追加しても通知が来ない
			service.addMessage("y")
			expect(changed).not.toHaveBeenCalled()
		})
	})
})
