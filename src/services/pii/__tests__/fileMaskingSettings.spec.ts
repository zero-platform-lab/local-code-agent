import type { PiiMasking } from "@openai-agent/types"

const model = vi.hoisted(() => ({
	load: vi.fn(),
	detect: vi.fn(),
}))
vi.mock("../nerBackend", () => ({ loadBackend: model.load, detectWith: model.detect }))
vi.mock("../nerModel", () => ({
	hasNerRuntime: () => true,
	defaultModelDirectory: () => "/tmp/default-ner",
	describeCheck: () => "missing model",
}))

import { MEMO_LIMIT } from "../maskConversation"

import { TaskPiiMasker } from "../TaskPiiMasker"

beforeEach(() => {
	model.load.mockReset()
	model.detect.mockReset()
})

it("モデル未配置から保存先を変えると、会話なしでも読み直す", async () => {
	const settings: PiiMasking = { properNouns: { enabled: true, modelPath: "/tmp/missing-model" } }
	model.load.mockResolvedValueOnce({ backend: undefined, check: { ok: false } })
	model.load.mockResolvedValueOnce({ backend: {}, check: { ok: true } })
	model.detect.mockResolvedValue([{ kind: "person", start: 0, end: 1, value: "森" }])
	const masker = new TaskPiiMasker(() => settings)
	await masker.properNounsFor(["森さん"])
	settings.properNouns!.modelPath = "/tmp/installed-model"
	const lookup = await masker.properNounsFor(["森さん"])
	expect(model.load).toHaveBeenLastCalledWith("/tmp/installed-model")
	expect(lookup?.("森さん")).toHaveLength(1)
})

it("しきい値を変えると、会話なしでも同じ本文を再判定する", async () => {
	const settings: PiiMasking = { properNouns: { enabled: true, minScore: 0.99 } }
	model.load.mockResolvedValue({ backend: {}, check: { ok: true } })
	model.detect.mockImplementation(async (_backend, _text, options) =>
		options.minScore > 0.9 ? [] : [{ kind: "person", start: 0, end: 1, value: "森" }],
	)
	const masker = new TaskPiiMasker(() => settings)
	expect((await masker.properNounsFor(["森さん"]))?.("森さん")).toEqual([])
	settings.properNouns!.minScore = 0.8
	expect((await masker.properNounsFor(["森さん"]))?.("森さん")).toHaveLength(1)
})

it("設定が同じなら、モデルと判定結果を再利用する", async () => {
	const settings: PiiMasking = { properNouns: { enabled: true } }
	model.load.mockResolvedValue({ backend: {}, check: { ok: true } })
	model.detect.mockResolvedValue([])
	const masker = new TaskPiiMasker(() => settings)
	await masker.properNounsFor(["森さん"])
	await masker.properNounsFor(["森さん"])
	expect(model.load).toHaveBeenCalledTimes(1)
	expect(model.detect).toHaveBeenCalledTimes(1)
})

it("対象を変えると、以前の判定結果を使わない", async () => {
	const settings: PiiMasking = { properNouns: { enabled: true, entities: ["PER"] } }
	model.load.mockResolvedValue({ backend: {}, check: { ok: true } })
	model.detect.mockImplementation(async (_backend, _text, options) =>
		options.entities.includes("PER") ? [{ kind: "person", start: 0, end: 1, value: "森" }] : [],
	)
	const masker = new TaskPiiMasker(() => settings)
	expect((await masker.properNounsFor(["森さん"]))?.("森さん")).toHaveLength(1)
	settings.properNouns!.entities = ["ORG"]
	expect((await masker.properNounsFor(["森さん"]))?.("森さん")).toEqual([])
})

it("モデル読み込みが文字列を投げても理由を保持する", async () => {
	model.load.mockRejectedValue("model unavailable")
	const masker = new TaskPiiMasker({ properNouns: { enabled: true } })
	expect(await masker.properNounsFor(["森さん"])).toBeUndefined()
	expect(masker.takeDictionaryTroubles().join()).toContain("model unavailable")
})

it("判定が文字列を投げても理由を保持する", async () => {
	model.load.mockResolvedValue({ backend: {}, check: { ok: true } })
	model.detect.mockRejectedValue("detect unavailable")
	const masker = new TaskPiiMasker({ properNouns: { enabled: true } })
	await masker.properNounsFor(["森さん"])
	expect(masker.takeDictionaryTroubles().join()).toContain("detect unavailable")
})

it("記憶の上限を超えた本文は、次の判定で記憶を破棄する", async () => {
	model.load.mockResolvedValue({ backend: {}, check: { ok: true } })
	model.detect.mockResolvedValue([])
	const masker = new TaskPiiMasker({ properNouns: { enabled: true } })
	const text = "a".repeat(MEMO_LIMIT + 1)
	await masker.properNounsFor([text])
	await masker.properNounsFor([text])
	expect(model.detect).toHaveBeenCalledTimes(2)
})
