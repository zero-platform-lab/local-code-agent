// npx vitest run core/tools/helpers/__tests__/imageHelpers.spec.ts
//
// 画像ヘルパーは read_file が画像を扱う際の要。ここで固定する不変条件は
//   - 拡張子から MIME を引き当て、未知拡張子でも既定（image/png）に落として壊れない
//   - サイズ上限・累積メモリ上限を超えたら「処理せずスキップ」を明示する
//   - 想定外入力（未知拡張子・大文字）でも例外で落ちない
// fs はモックし、i18n はキーを返すだけの薄いモックにして文言のブレを排除する。

import { describe, it, expect, vi, beforeEach } from "vitest"

// fs/promises をモック（namespace import に対応して named も default も用意）
vi.mock("fs/promises", () => ({
	default: { stat: vi.fn(), readFile: vi.fn() },
	stat: vi.fn(),
	readFile: vi.fn(),
}))

// i18n は「キー＋主要オプション」を返す薄いモック（初期化不要・文言に依存しない）
vi.mock("../../../../i18n", () => ({
	t: (key: string, opts?: Record<string, unknown>) => `[${key}] size=${opts?.size} max=${opts?.max}`,
}))

import * as fs from "fs/promises"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	SUPPORTED_IMAGE_FORMATS,
	IMAGE_MIME_TYPES,
	readImageAsDataUrlWithBuffer,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "../imageHelpers"

const mb = (n: number) => n * 1024 * 1024

beforeEach(() => {
	vi.clearAllMocks()
})

describe("imageHelpers - 定数", () => {
	it("既定の上限値と対応フォーマットを公開している", () => {
		expect(DEFAULT_MAX_IMAGE_FILE_SIZE_MB).toBe(5)
		expect(DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB).toBe(20)
		// 主要フォーマットが揃っている
		expect(SUPPORTED_IMAGE_FORMATS).toContain(".png")
		expect(SUPPORTED_IMAGE_FORMATS).toContain(".svg")
		// MIME テーブルと対応表が整合している
		for (const ext of SUPPORTED_IMAGE_FORMATS) {
			expect(IMAGE_MIME_TYPES[ext]).toBeTruthy()
		}
	})
})

describe("readImageAsDataUrlWithBuffer", () => {
	it("既知の拡張子から MIME を引いて data URL を組む", async () => {
		const buf = Buffer.from("hello-jpeg")
		vi.mocked(fs.readFile).mockResolvedValue(buf as never)

		const { dataUrl, buffer } = await readImageAsDataUrlWithBuffer("/x/pic.JPG")

		expect(buffer).toBe(buf)
		expect(dataUrl).toBe(`data:image/jpeg;base64,${buf.toString("base64")}`)
	})

	it("未知の拡張子でも image/png に落として壊れない", async () => {
		const buf = Buffer.from("unknown-ext")
		vi.mocked(fs.readFile).mockResolvedValue(buf as never)

		const { dataUrl } = await readImageAsDataUrlWithBuffer("/x/file.unknownext")

		expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true)
	})
})

describe("isSupportedImageFormat", () => {
	it("対応拡張子は true（大文字も許容）", () => {
		expect(isSupportedImageFormat(".png")).toBe(true)
		expect(isSupportedImageFormat(".JPEG")).toBe(true)
	})

	it("非対応拡張子は false", () => {
		expect(isSupportedImageFormat(".txt")).toBe(false)
		expect(isSupportedImageFormat("")).toBe(false)
	})
})

describe("validateImageForProcessing", () => {
	it("モデルが画像非対応なら unsupported_model でスキップ", async () => {
		const result = await validateImageForProcessing("/x/a.png", false, 5, 20, 0)

		expect(result.isValid).toBe(false)
		expect(result.reason).toBe("unsupported_model")
		// stat すら呼ばない（非対応なら読む前に弾く）
		expect(fs.stat).not.toHaveBeenCalled()
	})

	it("個別ファイルサイズ上限を超えたら size_limit でスキップ", async () => {
		vi.mocked(fs.stat).mockResolvedValue({ size: mb(6) } as never)

		const result = await validateImageForProcessing("/x/big.png", true, 5, 20, 0)

		expect(result.isValid).toBe(false)
		expect(result.reason).toBe("size_limit")
		expect(result.sizeInMB).toBeCloseTo(6, 5)
		// 文言に上限値が載る（i18n モックのキー経由）
		expect(result.notice).toContain("imageTooLarge")
	})

	it("累積メモリ上限を超えたら memory_limit でスキップ", async () => {
		vi.mocked(fs.stat).mockResolvedValue({ size: mb(8) } as never)

		// 個別上限(10MB)は満たすが、既に 15MB 使用済み + 今回 8MB = 23MB > 20MB
		const result = await validateImageForProcessing("/x/mid.png", true, 10, 20, 15)

		expect(result.isValid).toBe(false)
		expect(result.reason).toBe("memory_limit")
		expect(result.notice).toContain("Image skipped to avoid size limit")
	})

	it("上限内なら valid を返し、サイズを載せる", async () => {
		vi.mocked(fs.stat).mockResolvedValue({ size: mb(2) } as never)

		const result = await validateImageForProcessing("/x/ok.png", true, 5, 20, 0)

		expect(result.isValid).toBe(true)
		expect(result.reason).toBeUndefined()
		expect(result.sizeInMB).toBeCloseTo(2, 5)
	})
})

describe("processImageFile", () => {
	it("data URL・buffer・サイズ・notice を組み立てる", async () => {
		const buf = Buffer.alloc(2048, 1) // 2KB
		vi.mocked(fs.stat).mockResolvedValue({ size: buf.length } as never)
		vi.mocked(fs.readFile).mockResolvedValue(buf as never)

		const result = await processImageFile("/x/pic.png")

		expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
		expect(result.buffer).toBe(buf)
		expect(result.sizeInKB).toBe(2)
		expect(result.sizeInMB).toBeCloseTo(2048 / (1024 * 1024), 6)
		expect(result.notice).toContain("imageWithSize")
	})
})

describe("ImageMemoryTracker", () => {
	it("加算・取得・リセットができる", () => {
		const tracker = new ImageMemoryTracker()
		expect(tracker.getTotalMemoryUsed()).toBe(0)

		tracker.addMemoryUsage(3)
		tracker.addMemoryUsage(2.5)
		expect(tracker.getTotalMemoryUsed()).toBeCloseTo(5.5, 6)

		tracker.reset()
		expect(tracker.getTotalMemoryUsed()).toBe(0)
	})
})
