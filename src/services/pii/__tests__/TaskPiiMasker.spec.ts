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

vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))

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

	it("戻さない設定でも、明示的な操作なら戻す（FR-PII-20）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, restore: false, kinds: ["email"] })
		await masker.maskForRequest("", [message("taro@corp.example")])

		// 戻さないまま進めて最後にまとめて戻すのが、この操作の使い道である。
		expect(masker.unmask("{{email-001}}")).toBe("{{email-001}}")
		expect(masker.restoreExplicitly("{{email-001}}")).toBe("taro@corp.example")
	})

	it("切り替えを切ったあとでも、ツールの引数は戻す", async () => {
		const settings: { enabled: boolean; kinds: string[] } = { enabled: true, kinds: ["email"] }
		const masker = new TaskPiiMasker(() => settings as never)
		await masker.maskForRequest("", [message("taro@corp.example")])

		// モデルの文脈には割り当て済みの伏せ字が残っている。切ったことを理由に戻さないと、
		// 伏せ字がそのままファイルへ書かれる。
		settings.enabled = false

		expect(masker.unmask('{"content":"{{email-001}}"}')).toBe('{"content":"taro@corp.example"}')
	})

	it("切り替えを切ったあとでも、割り当て済みなら戻せる", async () => {
		const settings: { enabled: boolean; restore?: boolean; kinds: string[] } = { enabled: true, kinds: ["email"] }
		const masker = new TaskPiiMasker(() => settings as never)
		await masker.maskForRequest("", [message("taro@corp.example")])

		settings.enabled = false

		expect(masker.restoreExplicitly("{{email-001}}")).toBe("taro@corp.example")
	})

	it("設定が読めなくなっても、伏せる側は切れない", async () => {
		let readable = true
		const masker = new TaskPiiMasker(() => (readable ? ({ enabled: true, kinds: ["email"] } as never) : undefined))
		await masker.maskForRequest("", [message("taro@corp.example")])

		// 画面を閉じたなどで参照先が消えた状態。空を返すと黙って伏せなくなる。
		readable = false

		expect((await masker.maskForRequest("", [message("hanako@corp.example")])).messages[0]).toMatchObject({
			content: "{{email-002}}",
		})
	})

	it("1 つの文も伏せて、返ってきた文を戻せる（FR-PII-01）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"] })

		const masked = await masker.maskPrompt("taro@corp.example を直して")

		expect(masked.text).toBe("{{email-001}} を直して")
		// 返ってきた文は利用者の入力欄へ戻る。伏せ字のままでは読めない。
		expect(masked.restore("{{email-001}} の件")).toBe("taro@corp.example の件")
	})

	it("伏せていなければ、1 つの文も素通しする", async () => {
		const masker = new TaskPiiMasker({})

		const masked = await masker.maskPrompt("taro@corp.example")

		expect(masked.text).toBe("taro@corp.example")
		expect(masked.restore("そのまま")).toBe("そのまま")
	})

	it("伏せていなければ、戻す側も素通しする", () => {
		expect(new TaskPiiMasker({}).unmask("{{email-001}}")).toBe("{{email-001}}")
	})

	it("会話の途中の切り替えが効く（FR-PII-01b）", async () => {
		const settings: { enabled?: boolean; kinds?: string[] } = { enabled: false, kinds: ["email"] }
		const masker = new TaskPiiMasker(() => settings as never)

		expect((await masker.maskForRequest("", [message("taro@corp.example")])).messages[0]).toMatchObject({
			content: "taro@corp.example",
		})

		// 画面のボタンで入れる。抱え込んでいると、押しても効かない。
		settings.enabled = true

		expect((await masker.maskForRequest("", [message("taro@corp.example")])).messages[0]).toMatchObject({
			content: "{{email-001}}",
		})
	})

	it("種類を書かない設定でも動く", async () => {
		const masker = new TaskPiiMasker({ enabled: true })

		const result = await masker.maskForRequest("", [message("taro@corp.example")])

		// 種類を書かなければ全部を伏せる。
		expect(result.messages[0]).toMatchObject({ content: "{{email-001}}" })
	})

	it("設定が変わったら、覚えた結果を捨てる", async () => {
		const settings: { enabled: boolean; kinds: string[] } = { enabled: true, kinds: ["email"] }
		const masker = new TaskPiiMasker(() => settings as never)
		const text = "taro@corp.example と 03-1234-5678"

		expect((await masker.maskForRequest("", [message(text)])).messages[0]).toMatchObject({
			content: "{{email-001}} と 03-1234-5678",
		})

		// 種類を足したのに古い結果を返すと、増やした種類が効かない。
		settings.kinds = ["email", "phone"]

		expect((await masker.maskForRequest("", [message(text)])).messages[0]).toMatchObject({
			content: "{{email-001}} と {{phone-001}}",
		})
	})

	it("辞書の指す先が変わったら読み直す", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-masker-"))
		const dictionary = path.join(dir, "dict.txt")
		await fs.writeFile(dictionary, "アクメ\torg\n", "utf8")
		const settings: { enabled: boolean; kinds: string[]; dictionaryPaths: string[] } = {
			enabled: true,
			kinds: ["org"],
			dictionaryPaths: [],
		}
		const masker = new TaskPiiMasker(() => settings as never)

		expect((await masker.maskForRequest("", [message("アクメの件")])).messages[0]).toMatchObject({
			content: "アクメの件",
		})

		settings.dictionaryPaths = [dictionary]

		expect((await masker.maskForRequest("", [message("アクメの件")])).messages[0]).toMatchObject({
			content: "{{org-001}}の件",
		})

		await fs.rm(dir, { recursive: true, force: true })
	})

	it("辞書の語も使い、指す先が同じなら読み直さない", async () => {
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

	it("辞書が読めなかったことを黙らない（FR-PII-03d）", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"], dictionaryPaths: ["/無い/辞書.txt"] })

		const first = await masker.maskForRequest("", [message("taro@corp.example")])

		// 黙って進めると、社名も顧客名も伏せられないまま送られる。
		expect(first.troubles).toHaveLength(1)
		expect(first.troubles[0]).toContain("無い/辞書.txt")

		// 2 回目は出さない。要求のたびに同じ警告を出さない。
		const second = await masker.maskForRequest("", [message("taro@corp.example")])
		expect(second.troubles).toEqual([])
	})

	it("設定に直接書いた正規表現も効く（FR-PII-03f）", async () => {
		const masker = new TaskPiiMasker({
			enabled: true,
			kinds: ["term"],
			terms: [{ value: "EMP-\\d{5}", regex: true }],
		})

		const result = await masker.maskForRequest("", [message("担当は EMP-12345")])

		expect(result.messages[0]).toMatchObject({ content: "担当は {{term-001}}" })
	})
})
