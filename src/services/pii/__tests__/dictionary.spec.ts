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

const agentDir = vi.hoisted(() => ({ value: "" }))
vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => agentDir.value }))

import {
	decodeText,
	defaultDictionaryPath,
	parseDictionary,
	parseDictionaryLines,
	readDictionaries,
	resolveDictionaryPath,
} from "../dictionary"

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
		const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("サンプル")])

		// 1 語目の先頭に付くと一致しなくなる。
		expect(decodeText(withBom)).toBe("サンプル")
	})

	it("ASCII はどちらで読んでも同じになる", () => {
		expect(decodeText(new TextEncoder().encode("acme"))).toBe("acme")
	})
})

describe("parseDictionary（FR-PII-03c）", () => {
	it("1 行 1 語で読む", () => {
		expect(parseDictionary("サンプル\n田中太郎\n")).toEqual([
			{ value: "サンプル", kind: "term" },
			{ value: "田中太郎", kind: "term" },
		])
	})

	it("# で始まる行と空行を読み飛ばす", () => {
		expect(parseDictionary("# 顧客\n\nサンプル\n\n# ここまで\n")).toEqual([{ value: "サンプル", kind: "term" }])
	})

	it("タブの後ろの種類を読む", () => {
		expect(parseDictionary("田中太郎\tperson\n株式会社サンプル\torg\n")).toEqual([
			{ value: "田中太郎", kind: "person" },
			{ value: "株式会社サンプル", kind: "org" },
		])
	})

	it("知らない種類は term として扱う", () => {
		expect(parseDictionary("サンプル\tなにか\n")).toEqual([{ value: "サンプル", kind: "term" }])
	})

	it("前後の空白を落とす", () => {
		expect(parseDictionary("  サンプル  \n")).toEqual([{ value: "サンプル", kind: "term" }])
	})

	it("値が空白だけの行は読み飛ばす", () => {
		expect(parseDictionary("   \tperson\n")).toEqual([])
	})

	it("CRLF の改行も読む", () => {
		expect(parseDictionary("サンプル\r\n田中太郎\r\n")).toHaveLength(2)
	})
})

describe("正規表現（FR-PII-03f）", () => {
	it("スラッシュで囲むと正規表現として扱う", () => {
		expect(parseDictionary("/EMP-\\d{5}/\tterm\n")).toEqual([{ value: "EMP-\\d{5}", kind: "term", regex: true }])
	})

	it("囲まなければ普通の語として扱う", () => {
		// `.` を含む社名を書いたときに、いきなり正規表現として動くと危ない。
		expect(parseDictionary("A.C.M.E\n")).toEqual([{ value: "A.C.M.E", kind: "term" }])
	})

	it("書き間違えた正規表現は、行番号を添えて知らせる（FR-PII-03g）", () => {
		const parsed = parseDictionaryLines("# 見出し\n/EMP-[/\n")

		// 黙って読み飛ばすと、伏せているつもりで 1 件も一致しない。
		expect(parsed.terms).toEqual([])
		expect(parsed.problems).toHaveLength(1)
		expect(parsed.problems[0].line).toBe(2)
	})

	it("空の文字列に一致する書き方は受け付けない（FR-PII-03h）", () => {
		const parsed = parseDictionaryLines("/a*/\n")

		// 全ての位置に当たり、文書が伏せ字で埋まる。
		expect(parsed.terms).toEqual([])
		expect(parsed.problems[0].reason).toContain("空の文字列")
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
		await fs.writeFile(path.join(dir, "a.txt"), "サンプル\torg\n", "utf8")
		await fs.writeFile(path.join(dir, "b.txt"), SJIS_TANAKA)

		const result = await readDictionaries([path.join(dir, "a.txt"), path.join(dir, "b.txt")])

		expect(result.terms).toEqual([
			{ value: "サンプル", kind: "org" },
			{ value: "田中太郎", kind: "term" },
		])
		expect(result.failures).toEqual([])
	})

	it("読めない辞書があっても、読めたものは返す（FR-PII-03d）", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "サンプル\n", "utf8")

		const result = await readDictionaries([path.join(dir, "a.txt"), path.join(dir, "無い.txt")])

		// 辞書が無いことを理由に、ほかの種類の置き換えまで止めない。
		expect(result.terms).toEqual([{ value: "サンプル", kind: "term" }])
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0].path).toContain("無い.txt")
	})

	it("辞書を 1 つも指定しなければ空を返す", async () => {
		expect(await readDictionaries([])).toEqual({ terms: [], failures: [], problems: [] })
	})

	it("使えない行は、どの辞書のどの行かを添えて返す（FR-PII-03g）", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "サンプル\n/EMP-[/\n", "utf8")

		const result = await readDictionaries([path.join(dir, "a.txt")])

		expect(result.terms).toEqual([{ value: "サンプル", kind: "term" }])
		expect(result.problems).toHaveLength(1)
		expect(result.problems[0]).toMatchObject({ line: 2, value: "/EMP-[/" })
		expect(result.problems[0].path).toContain("a.txt")
	})
})

describe("resolveDictionaryPath", () => {
	it("~ を展開する。設定の画面が例示する書き方が読めないと、伏せたつもりで素通りする", () => {
		expect(resolveDictionaryPath("~/.agent/dict.txt")).toBe(path.join(os.homedir(), ".agent/dict.txt"))
		expect(resolveDictionaryPath("~")).toBe(os.homedir())
	})

	it("空の行は落とす。画面の「辞書を足す」が空のパスを積むため", () => {
		expect(resolveDictionaryPath("")).toBeUndefined()
		expect(resolveDictionaryPath("   ")).toBeUndefined()
	})

	it("絶対パスはそのまま", () => {
		expect(resolveDictionaryPath("/w/dict.txt")).toBe("/w/dict.txt")
	})
})

describe("既定の辞書（FR-PII-15b）", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-default-"))
		agentDir.value = dir
	})

	afterEach(async () => {
		agentDir.value = ""
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("設定に無くても、あれば読む", async () => {
		await fs.writeFile(defaultDictionaryPath(), "サンプル\torg\n", "utf8")

		// 右クリックで足した先を読まなければ、足した語は二度と効かない。
		const result = await readDictionaries([])

		expect(result.terms).toEqual([{ value: "サンプル", kind: "org" }])
	})

	it("無いときは足さない。読めない旨も出さない", async () => {
		const result = await readDictionaries([])

		expect(result.terms).toEqual([])
		expect(result.failures).toEqual([])
	})

	it("二重には読まない", async () => {
		await fs.writeFile(defaultDictionaryPath(), "サンプル\n", "utf8")

		const result = await readDictionaries([defaultDictionaryPath()])

		expect(result.terms).toHaveLength(1)
	})
})
