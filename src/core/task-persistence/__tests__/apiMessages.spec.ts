// cd src && npx vitest run core/task-persistence/__tests__/apiMessages.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { existsSync, unlinkSync } from "node:fs"

import { type ApiMessage, readApiMessages, saveApiMessages } from "../apiMessages"
import { safeWriteJson } from "../../../utils/safeWriteJson"

// `fs/promises` は既存テストがテンポラリディレクトリで実 I/O を行っているため、
// 実装をそのまま透過させたうえで `unlink` だけ差し替え可能にする
// （旧ファイル削除の順序・失敗時の挙動を観測するため）。
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		unlink: vi.fn((...args: unknown[]) => (actual.unlink as (..._a: unknown[]) => Promise<void>)(...args)),
	}
})

// `safeWriteJson` も既定では本物を呼ぶ（読み込み→保存→読み込みの往復を実ファイルで
// 確認したいため）。失敗ケースだけテスト側から差し替える。
vi.mock("../../../utils/safeWriteJson", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/safeWriteJson")>()
	return {
		...actual,
		safeWriteJson: vi.fn((...args: unknown[]) =>
			(actual.safeWriteJson as (..._a: unknown[]) => Promise<void>)(...args),
		),
	}
})

let tmpBaseDir: string

beforeEach(async () => {
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-api-"))
})

describe("apiMessages.readApiMessages", () => {
	it("returns empty array when api_conversation_history.json contains invalid JSON", async () => {
		const taskId = "task-corrupt-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, "<<<corrupt data>>>", "utf8")

		const result = await readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})

	it("returns empty array when claude_messages.json fallback contains invalid JSON", async () => {
		const taskId = "task-corrupt-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file (claude_messages.json), NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, "not json at all {[!", "utf8")

		const result = await readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])

		// The corrupted fallback file should NOT be deleted
		const stillExists = await fs
			.access(oldPath)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(true)
	})

	it("returns [] when file contains valid JSON that is not an array", async () => {
		const taskId = "task-non-array-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		const result = await readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})

	it("returns [] when fallback file contains valid JSON that is not an array", async () => {
		const taskId = "task-non-array-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file, NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, JSON.stringify({ key: "value" }), "utf8")

		const result = await readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// 以下は追加分。会話履歴の永続化点そのものなので、
// 「壊れたら履歴が消える」不変条件を優先して固定する。
// ---------------------------------------------------------------------------

/** テスト用のパス組み立て（製品コードと同じ規約: <base>/tasks/<taskId>/...）。 */
function taskPaths(baseDir: string, taskId: string) {
	const taskDir = path.join(baseDir, "tasks", taskId)
	return {
		taskDir,
		newPath: path.join(taskDir, "api_conversation_history.json"),
		oldPath: path.join(taskDir, "claude_messages.json"),
	}
}

/** 新形式（Responses item 列）のサンプル履歴。migrate は素通しになる。 */
function sampleMessages(): ApiMessage[] {
	return [
		{ type: "message", role: "user", content: "こんにちは", ts: 1 },
		{ type: "message", role: "assistant", content: "はい", ts: 2 },
		{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}', ts: 3 },
		{ type: "function_call_output", call_id: "call-1", output: "file body", ts: 4 },
	]
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("apiMessages.readApiMessages（追加分）", () => {
	it("新ファイルに有効な配列があればそのまま返す", async () => {
		const taskId = "task-valid-new"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages = sampleMessages()
		await fs.writeFile(newPath, JSON.stringify(messages), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual(messages)
		// 読み込みは非破壊。ファイルは残る。
		expect(existsSync(newPath)).toBe(true)
	})

	it("新ファイルが空配列なら [] を返す（ファイルは消さない）", async () => {
		const taskId = "task-empty-new"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(newPath, JSON.stringify([]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([])
		expect(existsSync(newPath)).toBe(true)
	})

	it("新ファイルが旧 Anthropic 形式でも item 列へ変換して返す", async () => {
		const taskId = "task-legacy-shape"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		// role/content 形式（トップレベルに type が無い）＝ 要マイグレーション。
		await fs.writeFile(newPath, JSON.stringify([{ role: "user", content: "旧形式", ts: 7 }]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([{ type: "message", role: "user", content: "旧形式", ts: 7 }])
	})

	it("新旧どちらのファイルも無ければ [] を返す", async () => {
		const taskId = "task-nothing"

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([])
		// 存在しない読み込みで unlink は起きない。
		expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled()
	})

	it("新ファイルがあれば旧ファイルは読まれず削除もされない", async () => {
		const taskId = "task-both"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages = sampleMessages()
		await fs.writeFile(newPath, JSON.stringify(messages), "utf8")
		await fs.writeFile(oldPath, JSON.stringify([{ role: "user", content: "旧" }]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual(messages)
		expect(existsSync(oldPath)).toBe(true)
		expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled()
	})
})

describe("apiMessages.readApiMessages のレガシー移行", () => {
	it("旧ファイルの有効な配列を返し、旧ファイルを削除する", async () => {
		const taskId = "task-legacy-migrate"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([{ role: "assistant", content: "旧履歴" }]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([{ type: "message", role: "assistant", content: "旧履歴" }])
		expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(oldPath)
		expect(existsSync(oldPath)).toBe(false)
		// 旧ファイルを消した以上、履歴は新ファイルに移っていなければならない。
		expect(existsSync(newPath)).toBe(true)
	})

	it("旧ファイルが空配列でも [] を返して削除する", async () => {
		const taskId = "task-legacy-empty"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([]), "utf8")

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([])
		expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(oldPath)
		expect(existsSync(oldPath)).toBe(false)
		expect(existsSync(newPath)).toBe(true)
	})

	it("【不変条件】旧ファイルを削除する時点で、新ファイルは既に書かれている", async () => {
		// これが移行の肝。呼び出し側（resumeTaskFromHistory）は履歴を読んだ直後に
		// 「タスクを再開しますか」でユーザーの応答を待つので、保存を呼び出し側に任せると
		// その待ち時間ぶんだけ「ディスク上にどこにも履歴が無い」窓が開く。待ち時間に上限は無い。
		// 消す前に書き切ることでこの窓を無くす。
		const taskId = "task-legacy-order"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([{ role: "user", content: "消えては困る履歴" }]), "utf8")

		let newFileExistedAtUnlink: boolean | undefined
		vi.mocked(fs.unlink).mockImplementationOnce(async (target) => {
			newFileExistedAtUnlink = existsSync(newPath)
			unlinkSync(target as string)
		})

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([{ type: "message", role: "user", content: "消えては困る履歴" }])
		expect(newFileExistedAtUnlink, "旧ファイル削除の時点で新ファイルが無い").toBe(true)
		expect(existsSync(oldPath)).toBe(false)
		expect(existsSync(newPath)).toBe(true)
	})

	it("【不変条件】新ファイルの書き込みに失敗したら旧ファイルは残す", async () => {
		// 書けなかったのに消したら履歴が消滅する。ディスク満杯や権限で普通に起こりうる。
		const taskId = "task-legacy-write-fail"
		const { taskDir, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([{ role: "user", content: "消えては困る履歴" }]), "utf8")

		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("ENOSPC: no space left on device"))

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toThrow("ENOSPC")

		expect(vi.mocked(fs.unlink), "書き込み失敗後に unlink された").not.toHaveBeenCalled()
		expect(existsSync(oldPath)).toBe(true)
	})

	it("【不変条件】旧ファイルの削除に失敗しても、移行した履歴は返す", async () => {
		// unlink は try の外に出してある。削除失敗（EPERM など）で
		// パース済みの履歴を捨てるのは割に合わない。旧ファイルが残るだけなら
		// 次回また移行されるので実害は無い。
		const taskId = "task-legacy-unlink-fail"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([{ role: "user", content: "残る履歴" }]), "utf8")

		vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("EPERM: operation not permitted"))

		const result = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(result).toEqual([{ type: "message", role: "user", content: "残る履歴" }])
		// 新ファイルには書けているので、次回は新ファイル側が読まれる。
		expect(existsSync(newPath)).toBe(true)
		expect(existsSync(oldPath)).toBe(true)
	})
})

describe("apiMessages.saveApiMessages", () => {
	it("【不変条件】タスクディレクトリ配下の api_conversation_history.json へ書く", async () => {
		const taskId = "task-save-path"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		const messages = sampleMessages()

		await saveApiMessages({ messages, taskId, globalStoragePath: tmpBaseDir })

		const calls = vi.mocked(safeWriteJson).mock.calls
		expect(calls).toHaveLength(1)
		const [writtenPath, writtenData] = calls[0]
		expect(writtenPath).toBe(newPath)
		expect(writtenData).toEqual(messages)
		// タスクディレクトリから外へ出ない（`..` を含まない）こと。
		expect(path.relative(taskDir, writtenPath)).toBe("api_conversation_history.json")
	})

	it("【不変条件】保存の失敗は呼び出し側へ伝わる（握り潰さない）", async () => {
		const taskId = "task-save-throws"
		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("disk full"))

		await expect(
			saveApiMessages({ messages: sampleMessages(), taskId, globalStoragePath: tmpBaseDir }),
		).rejects.toThrow("disk full")
	})

	it("【不変条件】保存に失敗しても既存の履歴ファイルは残る", async () => {
		const taskId = "task-save-fail-keeps-old"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const existing = sampleMessages()
		await fs.writeFile(newPath, JSON.stringify(existing), "utf8")

		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("boom"))
		await expect(saveApiMessages({ messages: [], taskId, globalStoragePath: tmpBaseDir })).rejects.toThrow("boom")

		// 失敗した保存で既存履歴が壊れていないこと。
		expect(await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).toEqual(existing)
	})

	it("空配列を保存しても壊れない", async () => {
		const taskId = "task-save-empty"
		const { newPath } = taskPaths(tmpBaseDir, taskId)

		await saveApiMessages({ messages: [], taskId, globalStoragePath: tmpBaseDir })

		expect(existsSync(newPath)).toBe(true)
		expect(JSON.parse(await fs.readFile(newPath, "utf8"))).toEqual([])
		expect(await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).toEqual([])
	})

	it("巨大な配列でも往復で内容が変わらない", async () => {
		const taskId = "task-save-large"
		const messages: ApiMessage[] = Array.from({ length: 5000 }, (_, i) => ({
			type: "message" as const,
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `メッセージ ${i} ${"あ".repeat(50)}`,
			ts: i,
		}))

		await saveApiMessages({ messages, taskId, globalStoragePath: tmpBaseDir })
		const roundTripped = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(roundTripped).toHaveLength(5000)
		expect(roundTripped).toEqual(messages)
	})

	it("【不変条件】読み込み → 保存 → 読み込みで内容が変わらない", async () => {
		const taskId = "task-round-trip"
		const { taskDir, newPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages: ApiMessage[] = [
			...sampleMessages(),
			{ type: "reasoning", encrypted_content: "opaque-bytes", id: "rs-1", ts: 5 },
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "画像つき" },
					{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
				],
				ts: 6,
			},
		]
		await fs.writeFile(newPath, JSON.stringify(messages), "utf8")

		const first = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		await saveApiMessages({ messages: first, taskId, globalStoragePath: tmpBaseDir })
		const second = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(first).toEqual(messages)
		expect(second).toEqual(first)
	})

	it("レガシー移行で読んだ履歴を保存すると、新ファイルに書き戻される", async () => {
		const taskId = "task-legacy-then-save"
		const { taskDir, newPath, oldPath } = taskPaths(tmpBaseDir, taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(oldPath, JSON.stringify([{ role: "user", content: "移行対象" }]), "utf8")

		const migrated = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		await saveApiMessages({ messages: migrated, taskId, globalStoragePath: tmpBaseDir })

		expect(existsSync(newPath)).toBe(true)
		expect(await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).toEqual(migrated)
		expect(existsSync(oldPath)).toBe(false)
	})
})
