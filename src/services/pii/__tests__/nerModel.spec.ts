// npx vitest run services/pii/__tests__/nerModel.spec.ts
//
// モデルのファイルの照合。
//
// **確かめたいのは「欠けたモデルを黙って読まない」ことである。** 265 MB を網か媒体で
// 運ぶので、途中で欠けることがある。欠けたまま読むと、読み込みが失敗するか、静かに
// 検出が甘くなる。後者は画面に何も出ないので、誰も気づけない。

import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"
import { promises as fs } from "fs"

const mocks = vi.hoisted(() => ({ globalAgentDirectory: "/w/.agent" }))

vi.mock("../../agent-config", () => ({
	getGlobalAgentDirectory: () => mocks.globalAgentDirectory,
}))

import {
	CHECKSUM_FILE,
	defaultModelDirectory,
	describeCheck,
	parseChecksums,
	REQUIRED_FILES,
	verifyModel,
} from "../nerModel"

let dir: string

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** 要るファイルを全部置き、`SHA256SUMS` も正しく書く。 */
async function placeModel(overrides: Record<string, string> = {}): Promise<void> {
	const lines: string[] = []
	for (const name of REQUIRED_FILES) {
		const body = overrides[name] ?? `${name} の中身`
		const target = path.join(dir, name)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, body, "utf8")
		lines.push(`${sha(`${name} の中身`)}  ./${name}`)
	}
	// 配るときの書庫の行も入っている。展開したあとには無い。
	lines.push(`${sha("書庫")}  ner-ja.tar.gz`)
	await fs.writeFile(path.join(dir, CHECKSUM_FILE), lines.join("\n") + "\n", "utf8")
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-ner-"))
	mocks.globalAgentDirectory = dir
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

describe("defaultModelDirectory（FR-PII-23a）", () => {
	it("設定の置き場所の下になる", () => {
		expect(defaultModelDirectory()).toBe(path.join(dir, "pii-ner"))
	})
})

describe("parseChecksums", () => {
	it("値と相対パスを読む", () => {
		const sums = parseChecksums(`${"a".repeat(64)}  ./config.json\n`)

		expect(sums.get("config.json")).toBe("a".repeat(64))
	})

	it("2 進数として書かれた印（*）も読む", () => {
		const sums = parseChecksums(`${"b".repeat(64)} *onnx/model_quantized.onnx\n`)

		expect(sums.get("onnx/model_quantized.onnx")).toBe("b".repeat(64))
	})

	it.each([
		["空の行", ""],
		["説明の行", "# これは説明"],
		["値が短い", `${"c".repeat(10)}  config.json`],
	])("%s は読み飛ばす", (_label, line) => {
		expect(parseChecksums(line).size).toBe(0)
	})
})

describe("verifyModel（FR-PII-23e）", () => {
	it("全部そろっていれば通る", async () => {
		await placeModel()

		expect(await verifyModel(dir)).toEqual({ ok: true, missing: [], mismatched: [] })
	})

	it("照合する値が無ければ、読まない", async () => {
		// 値の分からないモデルを読むくらいなら、第 2 層を動かさないほうがよい。
		expect(await verifyModel(dir)).toEqual({ ok: false, missing: [CHECKSUM_FILE], mismatched: [] })
	})

	it("ファイルが欠けていれば、そう言う", async () => {
		await placeModel()
		await fs.rm(path.join(dir, "tokenizer.json"))

		const check = await verifyModel(dir)

		expect(check.ok).toBe(false)
		expect(check.missing).toEqual(["tokenizer.json"])
	})

	it("中身が違えば、そう言う", async () => {
		// 運ぶ途中で欠けた場合。大きさが同じでも値で分かる。
		await placeModel({ "onnx/model_quantized.onnx": "壊れている" })

		const check = await verifyModel(dir)

		expect(check.ok).toBe(false)
		expect(check.mismatched).toEqual(["onnx/model_quantized.onnx"])
	})

	it("並びに載っていないファイルは、置かれていない扱いにする", async () => {
		await placeModel()
		const text = await fs.readFile(path.join(dir, CHECKSUM_FILE), "utf8")
		const without = text
			.split("\n")
			.filter((line) => !line.endsWith("./config.json"))
			.join("\n")
		await fs.writeFile(path.join(dir, CHECKSUM_FILE), without, "utf8")

		expect((await verifyModel(dir)).missing).toEqual(["config.json"])
	})
})

describe("describeCheck（FR-PII-22a）", () => {
	it("通っていれば何も言わない", () => {
		expect(describeCheck({ ok: true, missing: [], mismatched: [] })).toBeUndefined()
	})

	it.each([
		[{ ok: false, missing: ["a"], mismatched: [] }, "置かれていない: a"],
		[{ ok: false, missing: [], mismatched: ["b"] }, "値が違う: b"],
		[{ ok: false, missing: ["a"], mismatched: ["b"] }, "置かれていない: a / 値が違う: b"],
	])("%o は %j になる", (check, expected) => {
		expect(describeCheck(check)).toBe(expected)
	})
})
