// npx vitest run services/pii/__tests__/dictionary.spec.ts
//
// 伏せる語の辞書の読み取り。
//
// **符号化の判別が要点である。** Shift_JIS の辞書を UTF-8 として読むと文字化けし、
// 1 件も一致しないまま「伏せているつもり」になる。気づけない失敗なので、本物の
// バイト列で確かめる。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import { decodeText, parseDictionary, readDictionaries } from "../dictionary"

/** Shift_JIS の「田中太郎」。`TextDecoder` に頼らず、バイト列として書く。 */
const SJIS_TANAKA = Uint8Array.from([0x93, 0x63, 0x92, 0x86, 0x91, 0xbe, 0x98, 0x59])

describe("decodeText（FR-PII-03e）", () => {
	it("UTF-8 を読む", () => {
		expect(decodeText(new TextEncoder().encode("田中太郎"))).toBe("田中太郎")
	})

	it("Shift_JIS を読む", () => {
		expect(decodeText(SJIS_TANAKA)).toBe("田中太郎")
	})

	it("BOM は本文に含めない", () => {
		const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("アクメ")])

		// 1 語目の先頭に付くと一致しなくなる。
		expect(decodeText(withBom)).toBe("アクメ")
	})

	it("ASCII はどちらで読んでも同じになる", () => {
		expect(decodeText(new TextEncoder().encode("acme"))).toBe("acme")
	})
})

describe("parseDictionary（FR-PII-03c）", () => {
	it("1 行 1 語で読む", () => {
		expect(parseDictionary("アクメ\n田中太郎\n")).toEqual([
			{ value: "アクメ", kind: "term" },
			{ value: "田中太郎", kind: "term" },
		])
	})

	it("# で始まる行と空行を読み飛ばす", () => {
		expect(parseDictionary("# 顧客\n\nアクメ\n\n# ここまで\n")).toEqual([{ value: "アクメ", kind: "term" }])
	})

	it("タブの後ろの種類を読む", () => {
		expect(parseDictionary("田中太郎\tperson\n株式会社アクメ\torg\n")).toEqual([
			{ value: "田中太郎", kind: "person" },
			{ value: "株式会社アクメ", kind: "org" },
		])
	})

	it("知らない種類は term として扱う", () => {
		expect(parseDictionary("アクメ\tなにか\n")).toEqual([{ value: "アクメ", kind: "term" }])
	})

	it("前後の空白を落とす", () => {
		expect(parseDictionary("  アクメ  \n")).toEqual([{ value: "アクメ", kind: "term" }])
	})

	it("値が空白だけの行は読み飛ばす", () => {
		expect(parseDictionary("   \tperson\n")).toEqual([])
	})

	it("CRLF の改行も読む", () => {
		expect(parseDictionary("アクメ\r\n田中太郎\r\n")).toHaveLength(2)
	})
})

describe("readDictionaries", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-dict-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("複数の辞書をまとめて読む", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "アクメ\torg\n", "utf8")
		await fs.writeFile(path.join(dir, "b.txt"), SJIS_TANAKA)

		const result = await readDictionaries([path.join(dir, "a.txt"), path.join(dir, "b.txt")])

		expect(result.terms).toEqual([
			{ value: "アクメ", kind: "org" },
			{ value: "田中太郎", kind: "term" },
		])
		expect(result.failures).toEqual([])
	})

	it("読めない辞書があっても、読めたものは返す（FR-PII-03d）", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "アクメ\n", "utf8")

		const result = await readDictionaries([path.join(dir, "a.txt"), path.join(dir, "無い.txt")])

		// 辞書が無いことを理由に、ほかの種類の置き換えまで止めない。
		expect(result.terms).toEqual([{ value: "アクメ", kind: "term" }])
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0].path).toContain("無い.txt")
	})

	it("辞書を 1 つも指定しなければ空を返す", async () => {
		expect(await readDictionaries([])).toEqual({ terms: [], failures: [] })
	})
})
