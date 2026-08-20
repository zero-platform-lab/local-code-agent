import * as path from "path"

import { resolveImageMentions } from "../resolveImageMentions"

vi.mock("../../tools/helpers/imageHelpers", () => ({
	isSupportedImageFormat: vi.fn((ext: string) =>
		[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".tif", ".avif"].includes(
			ext.toLowerCase(),
		),
	),
	readImageAsDataUrlWithBuffer: vi.fn(),
	validateImageForProcessing: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(() => ({
		getTotalMemoryUsed: vi.fn().mockReturnValue(0),
		addMemoryUsage: vi.fn(),
	})),
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
}))

import { validateImageForProcessing, readImageAsDataUrlWithBuffer } from "../../tools/helpers/imageHelpers"

const mockReadImageAsDataUrl = vi.mocked(readImageAsDataUrlWithBuffer)
const mockValidateImage = vi.mocked(validateImageForProcessing)

describe("resolveImageMentions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: validation passes
		mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
	})

	it("should append a data URL when a local png mention is present", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "Please look at @/assets/cat.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(path.resolve("/workspace", "assets/cat.png"))
		expect(result.text).toBe("Please look at @/assets/cat.png")
		expect(result.images).toEqual([dataUrl])
	})

	it("should support gif images (matching read_file)", async () => {
		const dataUrl = `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("gif-bytes") })

		const result = await resolveImageMentions({
			text: "See @/animation.gif",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
	})

	it("should support svg images (matching read_file)", async () => {
		const dataUrl = `data:image/svg+xml;base64,${Buffer.from("svg-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("svg-bytes") })

		const result = await resolveImageMentions({
			text: "See @/icon.svg",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
	})

	it("should ignore non-image mentions", async () => {
		const result = await resolveImageMentions({
			text: "See @/src/index.ts",
			images: [],
			cwd: "/workspace",
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip unreadable files (fail-soft)", async () => {
		mockReadImageAsDataUrl.mockRejectedValue(new Error("ENOENT"))

		const result = await resolveImageMentions({
			text: "See @/missing.webp",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should respect rooIgnoreController", async () => {
		const dataUrl = `data:image/jpeg;base64,${Buffer.from("jpg-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("jpg-bytes") })
		const rooIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(false),
		}

		const result = await resolveImageMentions({
			text: "See @/secret.jpg",
			images: [],
			cwd: "/workspace",
			rooIgnoreController,
		})

		expect(rooIgnoreController.validateAccess).toHaveBeenCalledWith("secret.jpg")
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should dedupe when mention repeats", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "@/a.png and again @/a.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toHaveLength(1)
	})

	it("should skip images when supportsImages is false", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			supportsImages: false,
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that exceed size limits", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "size_limit",
			notice: "Image too large",
		})

		const result = await resolveImageMentions({
			text: "See @/huge.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that would exceed memory limit", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "memory_limit",
			notice: "Would exceed memory limit",
		})

		const result = await resolveImageMentions({
			text: "See @/large.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should pass custom size limits to validation", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			maxImageFileSize: 10,
			maxTotalImageSize: 50,
		})

		expect(mockValidateImage).toHaveBeenCalledWith(expect.any(String), true, 10, 50, 0)
	})

	it("should return early (slicing to the cap) when images already at the max", async () => {
		// 既に上限枚数（20）に達している場合は一切処理せず、先頭20枚に切り詰めて返す
		const existing = Array.from({ length: 21 }, (_, i) => `data:image/png;base64,img${i}`)

		const result = await resolveImageMentions({
			text: "See @/cat.png",
			images: existing,
			cwd: "/workspace",
		})

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toHaveLength(20)
		expect(result.images).toEqual(existing.slice(0, 20))
	})

	it("should return unchanged when text has no mentions at all", async () => {
		const result = await resolveImageMentions({
			text: "just plain text with no at-mentions",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip image mentions that resolve outside the cwd", async () => {
		// ワークスペース外に解決されるパス（../ 混じり）は読み込まず握り込む
		const result = await resolveImageMentions({
			text: "See @/../secret.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should treat a missing images argument as an empty list", async () => {
		// images 未指定（undefined）でも Array.isArray の既定 [] 経路で処理できる（実装 69 行）
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })

		const result = await resolveImageMentions({
			text: "See @/cat.png",
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
	})

	it("should ignore mentions that are not path mentions (do not start with '/')", async () => {
		// "@problems" のようなパス以外のメンションは startsWith('/') が false で除外される（実装 87 行）
		const result = await resolveImageMentions({
			text: "See @problems for details",
			images: [],
			cwd: "/workspace",
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should stop processing once the max image count is reached mid-loop", async () => {
		const dataUrl = "data:image/png;base64,newone"
		mockReadImageAsDataUrl.mockResolvedValue({ dataUrl, buffer: Buffer.from("png-bytes") })
		// 既存19枚 + 2枚のメンション → 1枚追加した時点で20に到達し、2枚目はループ冒頭で break
		const existing = Array.from({ length: 19 }, (_, i) => `data:image/png;base64,img${i}`)

		const result = await resolveImageMentions({
			text: "See @/a.png and @/b.png",
			images: existing,
			cwd: "/workspace",
		})

		// 1枚目だけ読み込まれ、2枚目は break により読み込まれない
		expect(mockReadImageAsDataUrl).toHaveBeenCalledTimes(1)
		expect(result.images).toHaveLength(20)
		expect(result.images[19]).toBe(dataUrl)
	})
})
