import { describe, it, expect, vi, beforeEach } from "vitest"

import { TaskMessageStore } from "../TaskMessageStore"

// disk I/O 本体は task-persistence の関数へ委譲されるので pin する。
vi.mock("../../task-persistence", () => ({
	readApiMessages: vi.fn(),
	saveApiMessages: vi.fn(),
	readTaskMessages: vi.fn(),
	saveTaskMessages: vi.fn(),
}))

import { readApiMessages, saveApiMessages, readTaskMessages, saveTaskMessages } from "../../task-persistence"

const mockedReadApi = vi.mocked(readApiMessages)
const mockedSaveApi = vi.mocked(saveApiMessages)
const mockedReadTask = vi.mocked(readTaskMessages)
const mockedSaveTask = vi.mocked(saveTaskMessages)

const TASK_ID = "task-42"
const STORAGE = "/global/storage"

function makeStore() {
	return new TaskMessageStore(TASK_ID, STORAGE)
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedReadApi.mockResolvedValue([])
	mockedReadTask.mockResolvedValue([])
	mockedSaveApi.mockResolvedValue(undefined)
	mockedSaveTask.mockResolvedValue(undefined)
	vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("TaskMessageStore", () => {
	it("初期状態では apiConversationHistory / clineMessages が空配列", () => {
		const store = makeStore()

		expect(store.apiConversationHistory).toEqual([])
		expect(store.clineMessages).toEqual([])
	})

	it("readApiConversationHistory は readApiMessages に taskId/globalStoragePath を渡し結果をそのまま返す", async () => {
		const store = makeStore()
		const sentinel = [{ role: "user", content: "loaded" }] as never
		mockedReadApi.mockResolvedValue(sentinel)

		const result = await store.readApiConversationHistory()

		expect(mockedReadApi).toHaveBeenCalledWith({ taskId: TASK_ID, globalStoragePath: STORAGE })
		expect(result).toBe(sentinel)
	})

	it("readClineMessages は readTaskMessages に委譲し結果をそのまま返す", async () => {
		const store = makeStore()
		const sentinel = [{ ts: 1 }] as never
		mockedReadTask.mockResolvedValue(sentinel)

		const result = await store.readClineMessages()

		expect(mockedReadTask).toHaveBeenCalledWith({ taskId: TASK_ID, globalStoragePath: STORAGE })
		expect(result).toBe(sentinel)
	})

	it("saveApiConversationHistory は現在の履歴の clone を保存し true を返す", async () => {
		const store = makeStore()
		store.apiConversationHistory = [{ role: "user", content: "x" }] as never

		const result = await store.saveApiConversationHistory()

		expect(result).toBe(true)
		const arg = mockedSaveApi.mock.calls[0][0]
		expect(arg).toMatchObject({ taskId: TASK_ID, globalStoragePath: STORAGE })
		// 参照ではなく snapshot（clone）が渡る
		expect(arg.messages).toEqual(store.apiConversationHistory)
		expect(arg.messages).not.toBe(store.apiConversationHistory)
	})

	it("saveApiConversationHistory は saveApiMessages が throw したら error ログして false を返す", async () => {
		const store = makeStore()
		store.apiConversationHistory = [{ role: "user", content: "x" }] as never
		mockedSaveApi.mockRejectedValueOnce(new Error("disk full"))

		const result = await store.saveApiConversationHistory()

		expect(result).toBe(false)
		expect(console.error).toHaveBeenCalledWith("Failed to save API conversation history:", expect.any(Error))
	})

	it("saveClineMessagesToDisk は clineMessages の clone を saveTaskMessages に渡す", async () => {
		const store = makeStore()
		store.clineMessages = [{ ts: 1 }, { ts: 2 }] as never

		await store.saveClineMessagesToDisk()

		const arg = mockedSaveTask.mock.calls[0][0]
		expect(arg).toMatchObject({ taskId: TASK_ID, globalStoragePath: STORAGE })
		expect(arg.messages).toEqual(store.clineMessages)
		expect(arg.messages).not.toBe(store.clineMessages)
	})

	it("saveClineMessagesToDisk は saveTaskMessages の失敗を握らずそのまま throw する", async () => {
		const store = makeStore()
		mockedSaveTask.mockRejectedValueOnce(new Error("write boom"))

		await expect(store.saveClineMessagesToDisk()).rejects.toThrow("write boom")
	})

	it("findMessageByTimestamp は一致する ts のメッセージを返す", () => {
		const store = makeStore()
		store.clineMessages = [{ ts: 1 }, { ts: 2 }, { ts: 3 }] as never

		expect(store.findMessageByTimestamp(2)).toEqual({ ts: 2 })
	})

	it("findMessageByTimestamp は後方から探索し、同一 ts が複数なら末尾側を返す", () => {
		const store = makeStore()
		store.clineMessages = [
			{ ts: 5, tag: "first" },
			{ ts: 5, tag: "last" },
		] as never

		expect(store.findMessageByTimestamp(5)).toEqual({ ts: 5, tag: "last" })
	})

	it("findMessageByTimestamp は一致が無ければ undefined を返す", () => {
		const store = makeStore()
		store.clineMessages = [{ ts: 1 }] as never

		expect(store.findMessageByTimestamp(999)).toBeUndefined()
	})
})
