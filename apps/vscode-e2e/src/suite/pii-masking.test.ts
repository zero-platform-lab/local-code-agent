import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * 機密情報が拡張ホストの中で実際に伏せられるかを固定する（`FR-PII-01`）。
 *
 * **単体の試験と統合の試験では足りない。** どちらも送る手前の関数を直に呼んでいて、
 * VS Code の中を通っていない。設定の受け渡しや、タスクの組み立てのどこかで伏せる処理が
 * 抜けても気付けない。
 *
 * ここでは**フェイクのエンドポイントが受け取った本文**を見る。生の値が 1 つでも載って
 * いれば落ちる。
 *
 * **伏せない場合も確かめる。** 生の値が載ることを見ておかないと、この試験が本当に何かを
 * 見張っているのか分からない。
 */
suite("PII masking inside the extension host", function () {
	setDefaultSuiteTimeout(this)

	/** どれも作り物である。 */
	const SECRETS = {
		email: "taro@corp.example",
		org: "株式会社サンプル",
		card: "4111 1111 1111 1111",
	}

	const TEXT = `${SECRETS.org} の ${SECRETS.email} へ連絡。山田部長にも共有。番号は ${SECRETS.card}。`

	/** 1 往復させて、送られた本文をまとめて返す。 */
	async function sendAndCapture(piiMasking: unknown): Promise<string> {
		const api = globalThis.api
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要")

		fake.enqueue({ kind: "tool", name: "attempt_completion", arguments: { result: "ok" } })
		const before = fake.requests.length

		const collected: ClineMessage[] = []
		api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true, piiMasking } as never,
			text: TEXT,
		})

		await waitFor(() => fake.requests.length > before, { timeout: 60_000 })
		return JSON.stringify(fake.requests.slice(before))
	}

	test("シークレットモードが入なら、生の値は 1 つも載らない", async () => {
		const sent = await sendAndCapture({
			enabled: true,
			terms: [{ value: SECRETS.org, kind: "org" }],
		})

		for (const [name, value] of Object.entries(SECRETS)) {
			assert.ok(!sent.includes(value), `${name} が載っている`)
		}
		// 敬称と肩書きの規則（`FR-PII-24`）も効く。肩書きは残す。
		assert.ok(!sent.includes("山田"), "肩書きの手前の名前が載っている")
		assert.ok(sent.includes("部長"), "肩書きまで伏せてはいけない")

		assert.ok(sent.includes("{{email-001}}"), "伏せ字が載っている")
		assert.ok(sent.includes("{{org-001}}"), "挙げた語の伏せ字が載っている")
	})

	test("切なら、生の値が載る", async () => {
		// これが載らないなら、上の試験は何も見張っていない。
		const sent = await sendAndCapture({})

		assert.ok(sent.includes(SECRETS.email), "伏せていないのに載っていない")
		assert.ok(sent.includes("山田部長"), "伏せていないのに載っていない")
	})

	test("第 2 層を入にしても、辞書に無い名前まで伏せる（FR-PII-21）", async function () {
		// モデルは同梱しない（`FR-PII-23`）。置いていない環境では飛ばす。
		const model = path.join(os.homedir(), ".agent", "pii-ner", "SHA256SUMS")
		if (!fs.existsSync(model)) {
			this.skip()
			return
		}

		const sent = await sendAndCapture({ enabled: true, properNouns: { enabled: true } })

		// 辞書にも敬称にも頼らずに社名が伏せられる。
		assert.ok(!sent.includes(SECRETS.org), "辞書に無い社名が載っている")
		assert.ok(sent.includes("{{org-001}}"), "第 2 層の伏せ字が載っている")
	})
})
