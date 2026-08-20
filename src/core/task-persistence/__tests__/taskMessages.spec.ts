import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { existsSync } from "node:fs"

// Mocks (use hoisted to avoid initialization ordering issues)
const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

// `fs/promises` は実 I/O を透過させたまま、`readFile` だけ差し替え可能にする
// （非 Error の reject という自然には起きない失敗を注入して catch の String(error) 経路を通すため）。
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: vi.fn((...args: unknown[]) => (actual.readFile as (..._a: unknown[]) => Promise<unknown>)(...args)),
	}
})

// Import after mocks
import { saveTaskMessages, readTaskMessages } from "../taskMessages"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	// Create a unique, writable temp directory to act as globalStoragePath
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-"))
})

describe("taskMessages.saveTaskMessages", () => {
	beforeEach(() => {
		hoisted.safeWriteJsonMock.mockClear()
	})

	it("persists messages as-is", async () => {
		const messages: any[] = [
			{
				role: "assistant",
				content: "Hello",
				metadata: {
					other: "keep",
				},
			},
			{ role: "user", content: "Do thing" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-1",
			globalStoragePath: tmpBaseDir,
		})

		expect(hoisted.safeWriteJsonMock).toHaveBeenCalledTimes(1)
		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})

	it("persists messages without modification when no metadata", async () => {
		const messages: any[] = [
			{ role: "assistant", content: "Hi" },
			{ role: "user", content: "Yo" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-2",
			globalStoragePath: tmpBaseDir,
		})

		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})
})

describe("taskMessages.readTaskMessages", () => {
	it("returns empty array when file contains invalid JSON", async () => {
		const taskId = "task-corrupt-json"
		// Manually create the task directory and write corrupted JSON
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, "{not valid json!!!", "utf8")

		const result = await readTaskMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})

	it("returns [] when file contains valid JSON that is not an array", async () => {
		const taskId = "task-non-array-json"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		const result = await readTaskMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})

	// -----------------------------------------------------------------------
	// 追加分。永続化点なので「読める・壊さない・往復で変わらない」を固定する。
	// -----------------------------------------------------------------------

	it("有効な配列はそのまま返す（読み込みは非破壊）", async () => {
		const taskId = "task-valid-array"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		const messages = [
			{ ts: 1, type: "say", say: "text", text: "a" },
			{ ts: 2, type: "ask", ask: "followup", text: "b" },
		]
		await fs.writeFile(filePath, JSON.stringify(messages), "utf8")

		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual(messages)
		// 読み込んでもファイルは残る。
		expect(existsSync(filePath)).toBe(true)
	})

	it("ファイルが存在しなければ [] を返す", async () => {
		const result = await readTaskMessages({ taskId: "task-missing", globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])
	})

	it("readFile が Error でない値で reject しても [] を返す（String(error) 経路）", async () => {
		const taskId = "task-nonerror-read"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		// 存在チェック（fs.access）は通す必要があるのでファイルは実在させる。
		await fs.writeFile(filePath, JSON.stringify([]), "utf8")

		// JSON.parse では常に Error 派生が飛ぶので、非 Error 経路は readFile の reject で作る。
		vi.mocked(fs.readFile).mockRejectedValueOnce("非 Error の理由")
		const result = await readTaskMessages({ taskId, globalStoragePath: tmpBaseDir })
		expect(result).toEqual([])
	})
})

describe("taskMessages.saveTaskMessages（不変条件）", () => {
	afterEach(() => {
		hoisted.safeWriteJsonMock.mockReset()
		hoisted.safeWriteJsonMock.mockResolvedValue(undefined)
	})

	it("タスクディレクトリ配下の ui_messages.json へ書く（外へ出ない）", async () => {
		const taskId = "task-save-path"
		await saveTaskMessages({ messages: [], taskId, globalStoragePath: tmpBaseDir })

		const [writtenPath] = hoisted.safeWriteJsonMock.mock.calls[0]
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		expect(writtenPath).toBe(path.join(taskDir, "ui_messages.json"))
		expect(path.relative(taskDir, writtenPath)).toBe("ui_messages.json")
	})

	it("保存の失敗は呼び出し側へ伝わる（握り潰さない）", async () => {
		hoisted.safeWriteJsonMock.mockRejectedValueOnce(new Error("disk full"))
		await expect(
			saveTaskMessages({ messages: [], taskId: "task-save-throw", globalStoragePath: tmpBaseDir }),
		).rejects.toThrow("disk full")
	})
})
