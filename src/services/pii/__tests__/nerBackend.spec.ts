// npx vitest run services/pii/__tests__/nerBackend.spec.ts
//
// 判定を実行する部分。
//
// **モデルは読まない。** 265 MB を試験のたびに読むわけにいかないので、偽の `NerBackend`
// を置く。判断の含まれる処理は全て `detectWith` の側にあり、そこはこれで確かめられる。
//
// **いちばん確かめたいのは索引のずれである。** 判定が返す索引は、前後の特殊な印を含めて
// 数えた位置である。印を足し忘れると 1 つずれ、全ての範囲が隣の断片を指す。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"
import { createHash } from "crypto"

vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/.agent" }))

const hf = vi.hoisted(() => ({
	tokenizer: {} as Record<string, unknown>,
	classified: [] as unknown[],
	env: { allowRemoteModels: true, localModelPath: "" },
	pipelineArgs: [] as unknown[],
}))

// 本物を読むと 265 MB のモデルが要る。読み込む段だけを偽物にする。
vi.mock("@huggingface/transformers", () => ({
	env: hf.env,
	AutoTokenizer: { from_pretrained: async () => hf.tokenizer },
	pipeline: async (...args: unknown[]) => {
		hf.pipelineArgs = args
		return async () => hf.classified
	},
}))

import { detectWith, loadBackend, type NerBackend } from "../nerBackend"
import type { ClassifiedToken } from "../nerSpans"
import { CHECKSUM_FILE, REQUIRED_FILES } from "../nerModel"

/** 本物と同じ形で返す偽物。分け方は 1 文字ずつではなく、実物に似せて置く。 */
function fakeBackend(pieces: string[], classified: ClassifiedToken[]): NerBackend {
	return {
		tokenize: () => pieces,
		classify: async () => classified,
		bos: "<s>",
		eos: "</s>",
	}
}

describe("detectWith（FR-PII-21）", () => {
	it("特殊な印を数に入れて、正しい位置を返す", () => {
		// 分けた並びは <s> ▁ 担当 は 鈴木 </s> なので、「鈴木」は索引 4 である。
		const backend = fakeBackend(
			["▁", "担当", "は", "鈴木"],
			[{ index: 4, entity: "PER", score: 0.99, word: "鈴木" }],
		)

		return expect(detectWith(backend, "担当は鈴木")).resolves.toEqual([
			{ kind: "person", start: 3, end: 5, value: "鈴木" },
		])
	})

	it("印を数に入れなければ、隣を指してしまう", async () => {
		// この試験は、上の試験が何を守っているかを示すために置いてある。
		// 索引 3 は「は」なので、人名として扱われてはならない位置である。
		const backend = fakeBackend(["▁", "担当", "は", "鈴木"], [{ index: 3, entity: "PER", score: 0.99, word: "は" }])

		const found = await detectWith(backend, "担当は鈴木")

		expect(found[0].value).toBe("は")
	})

	it("確度の低い判定は返らない", () => {
		const backend = fakeBackend(["▁", "森"], [{ index: 2, entity: "PER", score: 0.3, word: "森" }])

		return expect(detectWith(backend, "森")).resolves.toEqual([])
	})

	it("区分を指定できる", () => {
		const backend = fakeBackend(["▁", "React"], [{ index: 2, entity: "PRD", score: 0.99, word: "React" }])

		return expect(detectWith(backend, "React", { entities: ["PRD"] })).resolves.toEqual([
			{ kind: "term", start: 0, end: 5, value: "React" },
		])
	})

	it("何も見つからなければ空を返す", () => {
		return expect(detectWith(fakeBackend(["▁", "話"], []), "話")).resolves.toEqual([])
	})
})

describe("loadBackend（FR-PII-23b）", () => {
	let dir: string

	/** 照合に通る最小のモデルを置く。中身は読まれないので短くてよい。 */
	async function placeModel(): Promise<void> {
		const lines: string[] = []
		for (const name of REQUIRED_FILES) {
			const target = path.join(dir, name)
			await fs.mkdir(path.dirname(target), { recursive: true })
			await fs.writeFile(target, name, "utf8")
			lines.push(`${createHash("sha256").update(name).digest("hex")}  ./${name}`)
		}
		await fs.writeFile(path.join(dir, CHECKSUM_FILE), lines.join("\n") + "\n", "utf8")
	}

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-ner-load-"))
		hf.tokenizer = { tokenize: () => ["鈴木"], bos_token: "<s>", eos_token: "</s>" }
		hf.classified = []
		hf.env = { allowRemoteModels: true, localModelPath: "" }
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("モデルが置かれていなければ、何も返さない", async () => {
		// 誤りとして扱わない。第 2 層が動かないだけで、第 1 層はそのまま動く。
		const { backend, check } = await loadBackend(dir)

		expect(backend).toBeUndefined()
		// **照合の結果も返す。** 返さないと、理由を出すために 265 MB を二度読み直す。
		expect(check.missing).toEqual(["SHA256SUMS"])
	})

	it("照合に通れば読み、網へ取りに行かせない（FR-PII-22）", async () => {
		await placeModel()

		const { backend } = await loadBackend(dir)

		expect(backend).toBeDefined()
		// ここが真のままだと、置いていないファイルを網から取りに行く。
		expect(hf.env.allowRemoteModels).toBe(false)
		expect(hf.env.localModelPath).toBe(path.dirname(dir))
	})

	it("量子化した重みを選ぶ", async () => {
		await placeModel()

		await loadBackend(dir)

		// fp32 を選ぶと 1.03 GB を読み、1 回あたりも 2 倍かかる。
		expect(hf.pipelineArgs[2]).toEqual({ dtype: "q8" })
	})

	it("印が決まっていなければ、既定の形を使う", async () => {
		await placeModel()
		hf.tokenizer = { tokenize: () => [], bos_token: null, eos_token: null }

		const { backend } = await loadBackend(dir)

		expect(backend?.bos).toBe("<s>")
		expect(backend?.eos).toBe("</s>")
	})

	it("読んだものが、そのまま判定に使える", async () => {
		await placeModel()
		hf.tokenizer = { tokenize: () => ["▁", "鈴木"], bos_token: "<s>", eos_token: "</s>" }
		hf.classified = [{ index: 2, entity: "PER", score: 0.99, word: "鈴木" }]

		const { backend } = await loadBackend(dir)

		await expect(detectWith(backend!, "鈴木")).resolves.toEqual([
			{ kind: "person", start: 0, end: 2, value: "鈴木" },
		])
	})
})

describe("長い本文を窓に分ける（FR-PII-21）", () => {
	/**
	 * **本物の制約を写した偽物。**
	 *
	 * モデルは 512 断片までしか見ず、超えた分は黙って落とす。偽物が無制限だと、
	 * 落ちていることに試験が気づけない。ここでは渡された長さを見張り、長すぎれば
	 * 投げる。
	 */
	function strictBackend(limit: number): NerBackend {
		return {
			tokenize: (text) => [...text],
			classify: async (text) => {
				if (text.length > limit) throw new Error(`${limit} 文字を超えている: ${text.length}`)
				// 「森」を人名として返す。位置は窓の中での索引になる。
				const at = text.indexOf("森")
				return at < 0 ? [] : [{ index: at + 1, entity: "PER", score: 0.99, word: "森" }]
			},
			bos: "<s>",
			eos: "</s>",
		}
	}

	it("上限を超える本文でも、1 度に渡す量は上限を超えない", async () => {
		const text = "あ".repeat(2000) + "森"

		// 投げれば、窓に分けられていない。
		await expect(detectWith(strictBackend(256), text)).resolves.toBeDefined()
	})

	it("本文の終わりにある名前も拾う", async () => {
		// 分けないと、後ろが黙って落ちる。画面には何も出ない。
		const text = "あ".repeat(2000) + "森"

		const found = await detectWith(strictBackend(256), text)

		expect(found).toEqual([{ kind: "person", start: 2000, end: 2001, value: "森" }])
	})

	it("窓の重なりで二度出たものは 1 つにする", async () => {
		// 重なりの中にある名前は、2 つの窓の両方から見える。
		const text = "あ".repeat(240) + "森" + "い".repeat(300)

		const found = await detectWith(strictBackend(256), text)

		expect(found).toEqual([{ kind: "person", start: 240, end: 241, value: "森" }])
	})
})
