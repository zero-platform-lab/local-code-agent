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

const ner = vi.hoisted(() => ({
	/** 読めた体にするか。`undefined` なら「モデルが無い」。 */
	backend: undefined as unknown,
	/** 判定した回数。同じ本文を二度判定していないかを見る。 */
	calls: 0,
	check: { ok: false, missing: ["SHA256SUMS"], mismatched: [] },
}))

// モデルは 265 MB あり、試験のたびに読めない。読む段だけを偽物にする。
vi.mock("../nerBackend", () => ({
	loadBackend: async () => ner.backend,
	detectWith: async (_backend: unknown, text: string) => {
		ner.calls++
		// 「森」を人名として返す偽の判定。第 1 層には無い規則である。
		const at = text.indexOf("森")
		return at < 0 ? [] : [{ kind: "person", start: at, end: at + 1, value: "森" }]
	},
}))

vi.mock("../nerModel", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	verifyModel: async () => ner.check,
}))

import { lookupOf, TaskPiiMasker } from "../TaskPiiMasker"

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
		await fs.writeFile(dictionary, "サンプル\torg\n", "utf8")
		const settings: { enabled: boolean; kinds: string[]; dictionaryPaths: string[] } = {
			enabled: true,
			kinds: ["org"],
			dictionaryPaths: [],
		}
		const masker = new TaskPiiMasker(() => settings as never)

		expect((await masker.maskForRequest("", [message("サンプルの件")])).messages[0]).toMatchObject({
			content: "サンプルの件",
		})

		settings.dictionaryPaths = [dictionary]

		expect((await masker.maskForRequest("", [message("サンプルの件")])).messages[0]).toMatchObject({
			content: "{{org-001}}の件",
		})

		await fs.rm(dir, { recursive: true, force: true })
	})

	it("辞書へ語を足したら、次の要求から効く", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-masker-"))
		const dictionary = path.join(dir, "dict.txt")
		await fs.writeFile(dictionary, "サンプル\torg\n", "utf8")
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["org"], dictionaryPaths: [dictionary] })

		expect((await masker.maskForRequest("", [message("サンプルと葵")])).messages[0]).toMatchObject({
			content: "{{org-001}}と葵",
		})

		// 右クリックで語を足しても設定は変わらない。設定だけを見ていると、足した語が
		// その会話では二度と効かない。
		await new Promise((resolve) => setTimeout(resolve, 10))
		await fs.appendFile(dictionary, "葵\torg\n", "utf8")

		expect((await masker.maskForRequest("", [message("サンプルと葵")])).messages[0]).toMatchObject({
			content: "{{org-001}}と{{org-002}}",
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

describe("固有名詞の検出（第 2 層）（FR-PII-21）", () => {
	beforeEach(() => {
		ner.backend = {}
		ner.calls = 0
		ner.check = { ok: false, missing: ["SHA256SUMS"], mismatched: [] }
	})

	it("切のままなら実行しない", async () => {
		const masker = new TaskPiiMasker({ enabled: true })

		const result = await masker.maskForRequest("", [message("森が担当")])

		expect(ner.calls).toBe(0)
		expect(result.messages[0]).toMatchObject({ content: "森が担当" })
	})

	it("入れると、辞書に無い名前も伏せる", async () => {
		const masker = new TaskPiiMasker({ enabled: true, properNouns: { enabled: true } })

		// **敬称を付けない。** 付けると第 1 層の規則（`FR-PII-24`）が拾い、第 2 層を
		// 確かめたことにならない。
		const result = await masker.maskForRequest("", [message("森が担当")])

		expect(result.messages[0]).toMatchObject({ content: "{{person-001}}が担当" })
	})

	it("同じ本文を二度判定しない", async () => {
		const masker = new TaskPiiMasker({ enabled: true, properNouns: { enabled: true } })

		await masker.maskForRequest("", [message("森が担当")])
		const before = ner.calls
		await masker.maskForRequest("", [message("森が担当")])

		expect(ner.calls).toBe(before)
	})

	it("モデルが無ければ、第 1 層は動かしたうえでその旨を出す（FR-PII-22a・FR-PII-23b）", async () => {
		// 黙って第 1 層だけにすると、画面の見た目が変わらないので気づけない。
		ner.backend = undefined
		const masker = new TaskPiiMasker({
			enabled: true,
			kinds: ["email", "person"],
			properNouns: { enabled: true },
		})

		const result = await masker.maskForRequest("", [message("森が担当 taro@corp.example")])

		expect(result.messages[0]).toMatchObject({ content: "森が担当 {{email-001}}" })
		expect(result.troubles.join()).toContain("固有名詞の検出を実行できない")
		expect(result.troubles.join()).toContain("SHA256SUMS")
	})

	it("読めなかったことを毎回は言わない", async () => {
		ner.backend = undefined
		const masker = new TaskPiiMasker({ enabled: true, properNouns: { enabled: true } })

		await masker.maskForRequest("", [message("森")])
		const second = await masker.maskForRequest("", [message("森")])

		expect(second.troubles).toEqual([])
	})

	it("種類を切れば、第 2 層の結果も伏せない（FR-PII-21a）", async () => {
		// 種類の切り替えは第 1 層と第 2 層の両方に効く。
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"], properNouns: { enabled: true } })

		const result = await masker.maskForRequest("", [message("森が担当")])

		expect(result.messages[0]).toMatchObject({ content: "森が担当" })
	})

	it("置き場所を変えたら読み直す", async () => {
		const settings = { enabled: true, properNouns: { enabled: true, modelPath: "/w/a" } }
		const masker = new TaskPiiMasker(() => settings as never)
		await masker.maskForRequest("", [message("森")])

		ner.backend = undefined
		settings.properNouns = { enabled: true, modelPath: "/w/b" }
		const result = await masker.maskForRequest("", [message("森")])

		// 読み直さなければ、前のモデルを使い続けて伏せてしまう。
		expect(result.messages[0]).toMatchObject({ content: "森" })
	})
})

describe("lookupOf", () => {
	it("判定した本文は、その結果を返す", () => {
		const found = new Map([["森", [{ kind: "person" as const, start: 0, end: 1, value: "森" }]]])

		expect(lookupOf(found)("森")).toHaveLength(1)
	})

	it("判定していない本文は、第 2 層の対象外として扱う", () => {
		// 推測で伏せるより、第 1 層だけで伏せるほうが害が小さい。
		expect(lookupOf(new Map())("知らない文")).toEqual([])
	})
})

describe("覆っていなかった経路", () => {
	it("文の手直しでも第 2 層を通す（FR-PII-01）", async () => {
		// ここを通さないと、送る 3 つの呼び出しのうち 1 つだけが素通りする。
		ner.backend = {}
		const masker = new TaskPiiMasker({ enabled: true, properNouns: { enabled: true } })

		const result = await masker.maskPrompt("森が担当")

		expect(result.text).toBe("{{person-001}}が担当")
		expect(result.restore(result.text)).toBe("森が担当")
	})

	it("空白だけの辞書の指定は、時刻を見に行かない", async () => {
		const masker = new TaskPiiMasker({ enabled: true, kinds: ["email"], dictionaryPaths: ["   "] })

		const result = await masker.maskForRequest("", [message("taro@corp.example")])

		expect(result.messages[0]).toMatchObject({ content: "{{email-001}}" })
	})

	it("番号を振る係を渡せる", () => {
		// ファイルの置き換えと同じ係を使う。分けると同じ形の伏せ字が別の値を指す。
		const masker = new TaskPiiMasker({ enabled: true })

		expect(masker.allocator).toBe(masker.allocator)
	})
})
