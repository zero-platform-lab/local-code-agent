// cd src && npx vitest run core/task-persistence/__tests__/taskMetadata.spec.ts
//
// taskMetadata() は「保存する HistoryItem を組み立てる」純粋寄りの関数。
// 履歴の中身（task 文言・トークン集計・timestamp・size・sticky profile / status）が
// 入力メッセージから正しく導かれることを固定する。ディレクトリサイズ取得は外部 I/O
// なので get-folder-size をモックし、成功・失敗・キャッシュヒットの 3 経路を通す。

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@openai-agent/types"

// i18n は未初期化だと戻り値が不安定なので、キーをそのまま返すモックにして
// 「どの文言分岐に入ったか」を戻り値で判定できるようにする。
vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
	default: {},
}))

// ディレクトリサイズは外部 I/O。既定は固定値を返し、テストごとに差し替える。
vi.mock("get-folder-size", () => ({
	default: { loose: vi.fn(async () => 4096) },
}))

import getFolderSize from "get-folder-size"
import { taskMetadata } from "../taskMetadata"

// loose はオーバーロード（number / bigint）。製品コードが使うのは options 無し = number 版なので
// その単一シグネチャへ寄せてから mock 化し、mockResolvedValue(number) を型的に成立させる。
const loose = () => vi.mocked(getFolderSize.loose as (itemPath: string) => Promise<number>)

let tmpBaseDir: string

beforeEach(async () => {
	vi.clearAllMocks()
	loose().mockResolvedValue(4096)
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-meta-"))
})

/** say テキストメッセージ（タスク本文になる）。 */
function sayMessage(overrides: Partial<ClineMessage> = {}): ClineMessage {
	return { ts: 1000, type: "say", say: "text", text: "タスク本文", ...overrides } as ClineMessage
}

/** resume 系 ask メッセージ（lastRelevantMessage から除外される）。 */
function resumeAsk(overrides: Partial<ClineMessage> = {}): ClineMessage {
	return { ts: 5000, type: "ask", ask: "resume_task", text: "", ...overrides } as ClineMessage
}

describe("taskMetadata（メッセージなし）", () => {
	it("空配列ならトークン集計・size をゼロにし no_messages 文言を使う", async () => {
		const before = Date.now()
		const { historyItem, tokenUsage } = await taskMetadata({
			taskId: "meta-empty",
			taskNumber: 3,
			messages: [],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})

		expect(historyItem.task).toBe("common:tasks.no_messages")
		expect(historyItem.size).toBe(0)
		expect(historyItem.tokensIn).toBe(0)
		expect(historyItem.tokensOut).toBe(0)
		expect(tokenUsage.totalCost).toBe(0)
		// timestamp は Date.now() 由来（呼び出し前後の範囲に収まる）。
		expect(historyItem.ts).toBeGreaterThanOrEqual(before)
		expect(historyItem.ts).toBeLessThanOrEqual(Date.now())
		// size 取得は走らない。
		expect(loose()).not.toHaveBeenCalled()
	})

	it("messages が undefined でも no_messages 経路に落ちる（&& の左が falsy）", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-undef",
			taskNumber: 1,
			messages: undefined as unknown as ClineMessage[],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})

		expect(historyItem.task).toBe("common:tasks.no_messages")
		expect(historyItem.size).toBe(0)
	})
})

describe("taskMetadata（メッセージあり）", () => {
	it("先頭メッセージ本文を task にし、size は get-folder-size の値を使う", async () => {
		loose().mockResolvedValue(12345)
		const { historyItem } = await taskMetadata({
			taskId: "meta-basic",
			taskNumber: 1,
			messages: [sayMessage({ ts: 1111, text: "  最初のタスク  " })],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})

		// text は trim される。
		expect(historyItem.task).toBe("最初のタスク")
		expect(historyItem.ts).toBe(1111)
		expect(historyItem.size).toBe(12345)
		expect(loose()).toHaveBeenCalledTimes(1)
	})

	it("先頭メッセージの text が空白のみなら incomplete 文言にフォールバック", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-blank",
			taskNumber: 7,
			messages: [sayMessage({ text: "   " })],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		expect(historyItem.task).toBe("common:tasks.incomplete")
	})

	it("先頭メッセージの text が undefined でも incomplete 文言にフォールバック", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-notext",
			taskNumber: 7,
			messages: [sayMessage({ text: undefined })],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		expect(historyItem.task).toBe("common:tasks.incomplete")
	})

	it("timestamp は resume 系 ask を除いた最後のメッセージの ts", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-ts",
			taskNumber: 1,
			messages: [
				sayMessage({ ts: 100, text: "本文" }),
				sayMessage({ ts: 200, say: "text", text: "途中" }),
				resumeAsk({ ts: 9999 }),
			],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		// 末尾の resume_task は除外され、ts=200 が採用される。
		expect(historyItem.ts).toBe(200)
	})

	it("すべて resume 系 ask なら先頭メッセージへフォールバックする（findLastIndex=-1）", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-all-resume",
			taskNumber: 1,
			messages: [
				{ ts: 300, type: "ask", ask: "resume_task", text: "" } as ClineMessage,
				{ ts: 400, type: "ask", ask: "resume_completed_task", text: "" } as ClineMessage,
			],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		// lastRelevantMessage が無く taskMessage（先頭 ts=300）へ落ちる。
		expect(historyItem.ts).toBe(300)
	})

	it("get-folder-size が投げても size=0 にフォールバックし例外を握り潰す", async () => {
		loose().mockRejectedValueOnce(new Error("EACCES"))
		const { historyItem } = await taskMetadata({
			taskId: "meta-size-fail",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		expect(historyItem.size).toBe(0)
	})

	it("同じ taskDir の 2 回目はサイズをキャッシュから取り、get-folder-size を再呼び出ししない", async () => {
		loose().mockResolvedValue(777)
		const args = {
			taskId: "meta-cache",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		}

		const first = await taskMetadata(args)
		const second = await taskMetadata(args)

		expect(first.historyItem.size).toBe(777)
		expect(second.historyItem.size).toBe(777)
		// 2 回目はキャッシュヒットなので loose は 1 回だけ。
		expect(loose()).toHaveBeenCalledTimes(1)
	})
})

describe("taskMetadata（任意フィールド）", () => {
	it("rootTaskId / parentTaskId / mode を素通しする", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-rel",
			rootTaskId: "root-1",
			parentTaskId: "parent-1",
			taskNumber: 2,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws-x",
			mode: "code",
		})
		expect(historyItem.rootTaskId).toBe("root-1")
		expect(historyItem.parentTaskId).toBe("parent-1")
		expect(historyItem.number).toBe(2)
		expect(historyItem.workspace).toBe("/ws-x")
		expect(historyItem.mode).toBe("code")
	})

	it("apiConfigName が非空文字列なら含める", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-api",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
			apiConfigName: "openai-default",
		})
		expect(historyItem.apiConfigName).toBe("openai-default")
	})

	it("apiConfigName が空文字列なら含めない", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-api-empty",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
			apiConfigName: "",
		})
		expect("apiConfigName" in historyItem).toBe(false)
	})

	it("apiConfigName 未指定なら含めない", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-api-none",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		expect("apiConfigName" in historyItem).toBe(false)
	})

	it("initialStatus が指定されれば status に反映する", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-status",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
			initialStatus: "active",
		})
		expect(historyItem.status).toBe("active")
	})

	it("initialStatus 未指定なら status を付けない", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "meta-status-none",
			taskNumber: 1,
			messages: [sayMessage()],
			globalStoragePath: tmpBaseDir,
			workspace: "/ws",
		})
		expect("status" in historyItem).toBe(false)
	})
})
