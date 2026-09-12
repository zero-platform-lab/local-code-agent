// npx vitest run services/pii/__tests__/maskText.spec.ts
//
// 伏せ字への置き換えと、元の値への復元。
//
// **誤って伏せないこと**を、伏せることと同じ重さで確かめる。誤検出はモデルが読む内容を
// 変えるので、漏れより害が大きい場面がある。

import { myNumberCheckDigit, passesLuhn, passesMyNumberCheck } from "../detectors"
import { applyPlan, findPii, maskText, planMasking, resolveOverlaps, totalCount, unmaskText } from "../maskText"

describe("メールアドレス（FR-PII-04）", () => {
	it("伏せて、同じ値には同じ伏せ字を割り当てる（FR-PII-02）", () => {
		const result = maskText("連絡は taro@corp.example へ。写しも taro@corp.example へ。", { kinds: ["email"] })

		expect(result.text).toBe("連絡は {{email-001}} へ。写しも {{email-001}} へ。")
		expect(result.counts).toEqual({ email: 2 })
		expect(result.table.get("{{email-001}}")).toBe("taro@corp.example")
	})

	it("別の値には別の番号を割り当てる", () => {
		const result = maskText("taro@corp.example と hanako@corp.example", { kinds: ["email"] })

		expect(result.text).toBe("{{email-001}} と {{email-002}}")
	})
})

describe("電話番号（FR-PII-05）", () => {
	it.each(["03-1234-5678", "090-1234-5678", "0120-123-456", "+81-90-1234-5678", "0312345678"])(
		"%s は伏せる",
		(phone) => {
			const result = maskText(`電話は ${phone} です`, { kinds: ["phone"] })

			expect(result.text).toBe("電話は {{phone-001}} です")
		},
	)

	it("長い数字列の途中は伏せない", () => {
		// 時刻の値の中の 11 桁を拾うと、記録が読めなくなる。
		const text = "timestamp 1700000000000 end"

		expect(maskText(text, { kinds: ["phone"] }).text).toBe(text)
	})

	it.each(["1.2.3", "2026-09-12", "1234-5678"])("%s は伏せない", (text) => {
		// 0 で始まらない、あるいは桁が足りない。版番号や日付まで伏せると読めなくなる。
		expect(maskText(text, { kinds: ["phone"] }).text).toBe(text)
	})
})

describe("ホスト名（FR-PII-06）", () => {
	it.each([
		["git.example.internal へ繋ぐ", "{{host-001}} へ繋ぐ"],
		["https://git.example.internal/x", "https://{{host-001}}/x"],
		["srv.example.lan:8443", "{{host-001}}:8443"],
	])("%s は伏せる", (text, expected) => {
		expect(maskText(text, { kinds: ["host"] }).text).toBe(expected)
	})

	it.each(["github.com", "www.example.co.jp", "registry.npmjs.org"])("%s は伏せない（FR-PII-06b）", (host) => {
		// 伏せても守るものが無く、質問の意味が失われる。
		expect(maskText(`${host} を見る`, { kinds: ["host"] }).text).toBe(`${host} を見る`)
	})

	it.each([".env.local", "settings.local.json", "vite.config.local.ts", "assets.home.example.com"])(
		"ファイル名は伏せない: %s",
		(text) => {
			// モデルへ `.{{host-001}}` を編集させることになり、指示が読めなくなる。
			expect(maskText(`read ${text} please`, { kinds: ["host"] }).text).toBe(`read ${text} please`)
		},
	)

	it.each(["if (this.config.local) {", "state.private = true", "const x = opts.home;"])(
		"属性の参照は伏せない: %s",
		(text) => {
			// 識別子が {{host-001}} に変わると、モデルが読むコードが壊れる。
			expect(maskText(text, { kinds: ["host"] }).text).toBe(text)
		},
	)

	it("localhost.localdomain は伏せない（FR-PII-06a）", () => {
		expect(maskText("localhost.localdomain", { kinds: ["host"] }).text).toBe("localhost.localdomain")
	})
})

describe("IP アドレス（FR-PII-06d）", () => {
	it("グローバルは先頭 2 オクテットだけを伏せる", () => {
		const result = maskText("203.0.113.5 へ繋ぐ", { kinds: ["ip"] })

		expect(result.text).toBe("{{ip-001}}.113.5 へ繋ぐ")
		expect(result.table.get("{{ip-001}}")).toBe("203.0")
	})

	it.each([
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.254",
		"192.168.1.1",
		"127.0.0.1",
		"169.254.1.1",
		"0.0.0.0",
		// 事業者内の共用。特定の組織を表さない。
		"100.64.1.2",
		// マルチキャストと、サブネットマスク。伏せると設定ファイルが読めなくなる。
		"224.0.0.1",
		"255.255.255.0",
	])("%s は伏せない（FR-PII-06c FR-PII-06a）", (ip) => {
		expect(maskText(ip, { kinds: ["ip"] }).text).toBe(ip)
	})

	it("0 で始まる書き方でも、範囲がずれない", () => {
		// 数に直してから長さを測ると範囲がずれ、戻したときに別の文字列になる。
		const result = maskText("003.004.5.6", { kinds: ["ip"] })

		expect(result.text).toBe("{{ip-001}}.5.6")
		expect(unmaskText(result.text, result.table)).toBe("003.004.5.6")
	})

	it("オクテットが 255 を超える並びは IP と見なさない", () => {
		expect(maskText("999.1.1.1", { kinds: ["ip"] }).text).toBe("999.1.1.1")
	})

	it("172.15 と 172.32 はプライベートではない", () => {
		expect(maskText("172.15.0.1", { kinds: ["ip"] }).text).toBe("{{ip-001}}.0.1")
		expect(maskText("172.32.0.1", { kinds: ["ip"] }).text).toBe("{{ip-001}}.0.1")
	})
})

describe("クレジットカード（FR-PII-09）", () => {
	it("Luhn 検査に通る並びは伏せる", () => {
		const result = maskText("番号は 4111 1111 1111 1111 です", { kinds: ["card"] })

		expect(result.text).toBe("番号は {{card-001}} です")
	})

	it("倍にした桁が 9 を超える番号も伏せる", () => {
		// Luhn は 2 倍して 10 以上になった桁から 9 を引く。その経路を通す。
		expect(maskText("5555-5555-5555-4444", { kinds: ["card"] }).text).toBe("{{card-001}}")
	})

	it("Luhn 検査に通らない並びは伏せない（FR-PII-09a）", () => {
		// 注文番号やタイムスタンプまで伏せると読めなくなる。
		expect(maskText("4111111111111112", { kinds: ["card"] }).text).toBe("4111111111111112")
	})
})

describe("passesLuhn", () => {
	it("数字以外を含む文字列は通さない", () => {
		expect(passesLuhn("4111-1111")).toBe(false)
		expect(passesLuhn("")).toBe(false)
	})
})

describe("マイナンバー（FR-PII-14）", () => {
	// 正しい番号を外から持ち込まず、検査用数字の定義から組み立てる。
	const withCheckDigit = (first11: string) => `${first11}${myNumberCheckDigit(first11)}`

	it("検算に通る 12 桁を伏せる", () => {
		const number = withCheckDigit("12345678901")

		expect(maskText(`番号は ${number}`, { kinds: ["mynumber"] }).text).toBe("番号は {{mynumber-001}}")
	})

	it("区切りが入っていても伏せる", () => {
		const number = withCheckDigit("12345678901")
		const spaced = `${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`

		expect(maskText(spaced, { kinds: ["mynumber"] }).text).toBe("{{mynumber-001}}")
	})

	it("1 桁変えると検算に落ちる（FR-PII-14a）", () => {
		const number = withCheckDigit("12345678901")
		const broken = `${number.slice(0, 11)}${(Number(number[11]) + 1) % 10}`

		expect(passesMyNumberCheck(number)).toBe(true)
		expect(passesMyNumberCheck(broken)).toBe(false)
		expect(maskText(broken, { kinds: ["mynumber"] }).text).toBe(broken)
	})

	it.each([
		["長い数字列の一部", (n: string) => `${n}3`],
		["識別子の中", (n: string) => `abc${n}`],
		["語の途中", (n: string) => `${n}def`],
	])("%s の 12 桁は拾わない", (_label, wrap) => {
		// 区切られていない 12 桁は、番号として書かれたものではない。
		const embedded = wrap(withCheckDigit("12345678901"))

		expect(maskText(embedded, { kinds: ["mynumber"] }).text).toBe(embedded)
	})

	it("12 桁でない並びは見ない", () => {
		expect(passesMyNumberCheck("1234567890")).toBe(false)
	})

	it("余りが 1 以下なら検査用数字は 0 になる", () => {
		// 全部 0 なら ΣPQ も 0 で、余りは 0 である。
		expect(myNumberCheckDigit("00000000000")).toBe(0)
	})
})

describe("鍵（FR-PII-10）", () => {
	it.each([
		"sk-ant-api03-abcdefghijklmnopqrstuvwx",
		"ghp_abcdefghijklmnopqrstuvwxyz012345",
		"AKIAIOSFODNN7EXAMPLE",
		"glpat-abcdefghijklmnopqrst",
	])("既知の接頭辞 %s は伏せる", (secret) => {
		expect(maskText(`key: ${secret}`, { kinds: ["secret"] }).text).toBe("key: {{secret-001}}")
	})

	it.each(["api_key", "apiKey", "API-KEY", "x-api-key", "apikey"])(
		"ラベルの書き方の揺れを吸収する（FR-PII-10e）: %s",
		(label) => {
			const result = maskText(`${label} = "s3cr3tvalue"`, { kinds: ["secret"] })

			// 語そのものは残す（FR-PII-10c）。
			expect(result.text).toBe(`${label} = "{{secret-001}}"`)
		},
	)

	it("コードの参照は伏せない（FR-PII-10d）", () => {
		const text = "password = process.env.PASSWORD"

		expect(maskText(text, { kinds: ["secret"] }).text).toBe(text)
	})

	it.each(["password = short", "password = 12345", "token: a1"])("8 文字に満たない値は伏せない: %s", (text) => {
		expect(maskText(text, { kinds: ["secret"] }).text).toBe(text)
	})

	it("Authorization の値を伏せる（FR-PII-10f）", () => {
		const result = maskText("Authorization: Bearer abcdefghijklmnop", { kinds: ["secret"] })

		expect(result.text).toBe("Authorization: Bearer {{secret-001}}")
	})

	it("ラベルを足せる（FR-PII-10g）", () => {
		const result = maskText("社内トークン = abc123defg", { kinds: ["secret"], secretLabels: ["社内トークン"] })

		expect(result.text).toBe("社内トークン = {{secret-001}}")
	})

	it.each(["const apiKey = defaultApiKey", "let token = requestToken", "secret: buildSecret()"])(
		"普通の識別子は伏せない: %s",
		(text) => {
			// 識別子が {{secret-001}} に変わると、参照の関係が読めなくなる。
			expect(maskText(text, { kinds: ["secret"] }).text).toBe(text)
		},
	)

	it("引用符で囲まれていれば、数字が無くても伏せる", () => {
		expect(maskText('password = "changemenow"', { kinds: ["secret"] }).text).toBe('password = "{{secret-001}}"')
	})
})

describe("郵便番号（FR-PII-12）", () => {
	it("〒 が付く形は伏せる", () => {
		expect(maskText("〒150-0041 東京", { kinds: ["zip"] }).text).toBe("〒{{zip-001}} 東京")
	})

	it("語が前にあれば〒が無くても伏せる（FR-PII-12a）", () => {
		expect(maskText("郵便番号: 150-0041", { kinds: ["zip"] }).text).toBe("郵便番号: {{zip-001}}")
	})

	it("手がかりが無い NNN-NNNN は伏せない", () => {
		expect(maskText("品番 150-0041", { kinds: ["zip"] }).text).toBe("品番 150-0041")
	})
})

describe("住所（FR-PII-13）", () => {
	it("都道府県から始まる住所を伏せる", () => {
		const result = maskText("東京都渋谷区神南1-2-3 にある", { kinds: ["address"] })

		expect(result.text).toBe("{{address-001}} にある")
	})

	it("市区町村から始まる住所も伏せる", () => {
		const result = maskText("渋谷区神南1-2-3 にある", { kinds: ["address"] })

		expect(result.text).toBe("{{address-001}} にある")
	})

	it("丁目と番地の書き方も伏せる", () => {
		expect(maskText("千代田区丸の内1丁目2番3号", { kinds: ["address"] }).text).toBe("{{address-001}}")
	})

	it.each(["東京都の人口", "中央区の面積は広い", "那覇市について"])(
		"番地が無い %s は伏せない（FR-PII-13c）",
		(text) => {
			expect(maskText(text, { kinds: ["address"] }).text).toBe(text)
		},
	)

	it.each([
		"東京都の人口は 1400 万人です",
		"中央区の面積は 10 平方キロ",
		"光市場の調査 2024 年版",
		"那覇市を 3 回訪ねた",
	])("数字があっても、番地の形でなければ伏せない: %s", (text) => {
		// 「まず数字が来るまで」で採ると、地名のあとの普通の文章まで飲み込む。
		expect(maskText(text, { kinds: ["address"] }).text).toBe(text)
	})

	it("番地との間の空白は 1 つまで許す", () => {
		expect(maskText("東京都渋谷区神南 1-2-3", { kinds: ["address"] }).text).toBe("{{address-001}}")
	})

	it("一覧に無い語は住所と見なさない", () => {
		expect(maskText("架空市1-2-3", { kinds: ["address"] }).text).toBe("架空市1-2-3")
	})
})

describe("挙げた語（FR-PII-03）", () => {
	it("種類を指定すると伏せ字に出る", () => {
		const result = maskText("株式会社アクメの田中太郎", {
			kinds: ["org", "person"],
			terms: [
				{ value: "株式会社アクメ", kind: "org" },
				{ value: "田中太郎", kind: "person" },
			],
		})

		expect(result.text).toBe("{{org-001}}の{{person-001}}")
	})

	it("種類を指定しなければ term になる", () => {
		const result = maskText("プロジェクト葵", { terms: [{ value: "プロジェクト葵" }], kinds: ["term"] })

		expect(result.text).toBe("{{term-001}}")
	})

	it("小文字にすると長さが変わる文字があっても、範囲がずれない（FR-PII-03a）", () => {
		// `İ` は小文字にすると 2 符号単位になる。索引を借りると、そこから先が全部ずれる。
		const result = maskText("İstanbul ACME の件", { terms: [{ value: "ACME", kind: "org" }], kinds: ["org"] })

		expect(result.text).toBe("İstanbul {{org-001}} の件")
		expect(unmaskText(result.text, result.table)).toBe("İstanbul ACME の件")
	})

	it("英字の大文字小文字は区別しない（FR-PII-03a）", () => {
		const result = maskText("ACME と acme", { terms: [{ value: "Acme", kind: "org" }], kinds: ["org"] })

		// 復元を確かにするため、書き方が違えば別の番号を割り当てる。
		expect(result.text).toBe("{{org-001}} と {{org-002}}")
		expect(unmaskText(result.text, result.table)).toBe("ACME と acme")
	})

	it("正規表現として書いた語を伏せる（FR-PII-03f）", () => {
		const result = maskText("担当は EMP-12345 と EMP-67890", {
			// 種類を書かなければ term になる。
			terms: [{ value: "EMP-\\d{5}", regex: true }],
			kinds: ["term"],
		})

		expect(result.text).toBe("担当は {{term-001}} と {{term-002}}")
	})

	it("壊れた正規表現は 1 件も伏せない。本文は変わらない", () => {
		const text = "EMP-12345"

		expect(maskText(text, { terms: [{ value: "EMP-[", regex: true }], kinds: ["term"] }).text).toBe(text)
	})

	it("空に一致する正規表現は使わない（FR-PII-03h）", () => {
		const text = "なにか"

		expect(maskText(text, { terms: [{ value: "x*", regex: true }], kinds: ["term"] }).text).toBe(text)
	})

	it("長さ 0 に一致する位置は飛ばす", () => {
		// `\b` は空の文字列には一致しないので受け付けるが、本文では長さ 0 に一致する。
		const text = "abc def"

		expect(maskText(text, { terms: [{ value: "\\b", regex: true }], kinds: ["term"] }).text).toBe(text)
	})

	it("空の語は無視する", () => {
		expect(maskText("何か", { terms: [{ value: "   " }] }).text).toBe("何か")
	})
})

describe("種類の切り替え（FR-PII-07）", () => {
	it("選んだ種類だけを伏せる", () => {
		const text = "taro@corp.example と 203.0.113.5"

		expect(maskText(text, { kinds: ["email"] }).text).toBe("{{email-001}} と 203.0.113.5")
	})

	it("種類を指定しなければ全部を見る", () => {
		const result = maskText("taro@corp.example と 203.0.113.5")

		expect(totalCount(result.counts)).toBe(2)
	})

	it("空の一覧を渡すと 1 件も伏せない", () => {
		const text = "taro@corp.example"

		expect(maskText(text, { kinds: [] }).text).toBe(text)
		expect(totalCount(maskText(text, { kinds: [] }).counts)).toBe(0)
	})
})

describe("重なりの解き方", () => {
	it("始まりが同じなら長いほうを採る", () => {
		const kept = resolveOverlaps([
			{ kind: "phone", start: 0, end: 10, value: "a" },
			{ kind: "card", start: 0, end: 19, value: "b" },
		])

		expect(kept).toHaveLength(1)
		expect(kept[0].kind).toBe("card")
	})

	it("重ならないものは全部残す", () => {
		const kept = resolveOverlaps([
			{ kind: "email", start: 0, end: 5, value: "a" },
			{ kind: "email", start: 5, end: 9, value: "b" },
		])

		expect(kept).toHaveLength(2)
	})
})

describe("復元（FR-PII-02a）", () => {
	it("伏せた内容を元へ戻せる", () => {
		const text = "taro@corp.example は 203.0.113.5 の 東京都渋谷区神南1-2-3"
		const result = maskText(text)

		expect(result.text).not.toContain("taro@corp.example")
		expect(unmaskText(result.text, result.table)).toBe(text)
	})

	it("割り当てていない伏せ字には触らない（FR-PII-08a）", () => {
		const result = maskText("taro@corp.example", { kinds: ["email"] })
		const reply = `${result.text} と {{person-001}}`

		// 元から本文にあった同じ形の文字列を、別の値へ置き換えない。
		expect(unmaskText(reply, result.table)).toBe("taro@corp.example と {{person-001}}")
	})

	it("対応表が空なら何もしない", () => {
		expect(unmaskText("{{email-001}}", new Map())).toBe("{{email-001}}")
	})
})

describe("planMasking（FR-PII-11a）", () => {
	const text = "taro@corp.example と hanako@corp.example"

	it("範囲を渡さなければ全部を対象にする", () => {
		expect(planMasking(text, { kinds: ["email"] }).edits).toHaveLength(2)
	})

	it("範囲に収まる箇所だけを対象にする", () => {
		const plan = planMasking(text, { kinds: ["email"] }, { start: 0, end: 17 })

		expect(plan.edits).toHaveLength(1)
		expect(applyPlan(text, plan.edits)).toBe("{{email-001}} と hanako@corp.example")
	})

	it("範囲からはみ出す箇所は対象にしない", () => {
		// 途中で切れた値を伏せると、残りが本文に残って伏せた意味が無くなる。
		expect(planMasking(text, { kinds: ["email"] }, { start: 0, end: 10 }).edits).toHaveLength(0)
	})

	it("検出は本文全体で行う。範囲の外から続く並びを途中で切らない", () => {
		const address = "東京都渋谷区神南1-2-3"
		// 「東京都」だけを範囲にすると、住所は範囲に収まらないので対象にしない。
		expect(planMasking(address, { kinds: ["address"] }, { start: 0, end: 3 }).edits).toHaveLength(0)
		expect(planMasking(address, { kinds: ["address"] }).edits).toHaveLength(1)
	})
})

describe("findPii", () => {
	it("位置を返し、本文は変えない", () => {
		const matches = findPii("連絡は taro@corp.example へ", { kinds: ["email"] })

		expect(matches).toEqual([{ kind: "email", start: 4, end: 21, value: "taro@corp.example" }])
	})
})
