// npx vitest run services/pii/__tests__/TaskPiiMasker.spec.ts
//
// タスク 1 つ分の伏せ字。
//
// 固定するのは 3 点。
//   1. 既定では伏せないこと（FR-PII-01a）。気づかないうちに挙動が変わらない
//   2. **要求をまたいで同じ値へ同じ伏せ字**が当たること。食い違うとモデルは別人だと読む
//   3. 戻さない設定では素通しすること（FR-PII-19）

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import type { AgentMessage } from "@openai-agent/types"

import { TaskPiiMasker } from "../TaskPiiMasker"

const message = (content: string): AgentMessage => ({ type: "message", role: "user", content }) as AgentMessage

describe("TaskPiiMasker", () => {
	it("既定では伏せない（FR-PII-01a）", async () => {
		const masker = new TaskPiiMasker({})

		const result = await masker.maskForRequest("指示", [message("taro@corp.example")])

		expect(masker.enabled).toBe(false)
		expect(result.messages[0]).toMatchObject({ content: "taro@corp.example" })
		expect(result.counts).toEqual({})
	})

	it("入れると伏せる", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"] })

		const result = await masker.maskForRequest("指示", [message("taro@corp.example")])

		expect(result.messages[0]).toMatchObject({ content: "{{email-001}}" })
	})

	it("要求をまたいで同じ伏せ字を割り当てる（FR-PII-02）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"] })

		await masker.maskForRequest("", [message("taro@corp.example")])
		const second = await masker.maskForRequest("", [message("また taro@corp.example へ")])

		// 前の応答で使った伏せ字と食い違うと、モデルは別人だと読む。
		expect(second.messages[0]).toMatchObject({ content: "また {{email-001}} へ" })
		expect(masker.maskedCount).toBe(1)
	})

	it("伏せ字を元の値へ戻す（FR-PII-02a）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"] })
		await masker.maskForRequest("", [message("taro@corp.example")])

		expect(masker.restores).toBe(true)
		expect(masker.unmask('{"content":"{{email-001}}"}')).toBe('{"content":"taro@corp.example"}')
	})

	it("戻さない設定では素通しする（FR-PII-19）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, restore: false, kinds: ["email"] })
		await masker.maskForRequest("", [message("taro@corp.example")])

		// 文書を清書させるときは、モデルが書いた伏せ字をそのまま残したい。
		expect(masker.restores).toBe(false)
		expect(masker.unmask("{{email-001}}")).toBe("{{email-001}}")
	})

	it("伏せていなければ、戻す側も素通しする", () => {
		expect(new TaskPiiMasker({}).unmask("{{email-001}}")).toBe("{{email-001}}")
	})

	it("辞書の語も使い、読むのは 1 度だけにする", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-masker-"))
		const dictionary = path.join(dir, "dict.txt")
		await fs.writeFile(dictionary, "アクメ\torg\n", "utf8")
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["org"], dictionaryPaths: [dictionary] })

		expect((await masker.maskForRequest("", [message("アクメの件")])).messages[0]).toMatchObject({
			content: "{{org-001}}の件",
		})

		// 2 回目は読み直さない。要求のたびにファイルの入出力を増やさない。
		await fs.rm(dictionary)
		expect((await masker.maskForRequest("", [message("アクメの件")])).messages[0]).toMatchObject({
			content: "{{org-001}}の件",
		})

		await fs.rm(dir, { recursive: true, force: true })
	})

	it("辞書が読めなくても、ほかの種類の置き換えは続ける（FR-PII-03d）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"], dictionaryPaths: ["/無い/辞書.txt"] })

		const result = await masker.maskForRequest("", [message("taro@corp.example")])

		expect(result.messages[0]).toMatchObject({ content: "{{email-001}}" })
	})
})
