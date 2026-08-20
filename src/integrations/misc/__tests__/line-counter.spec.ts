import { describe, it, expect, vi, beforeEach } from "vitest"
import { countFileLines, countFileLinesAndTokens } from "../line-counter"
import { countTokens } from "../../../utils/countTokens"
import { Readable } from "stream"

// Mock dependencies
vi.mock("fs", () => ({
	default: {
		promises: {
			access: vi.fn(),
		},
		constants: {
			F_OK: 0,
		},
		createReadStream: vi.fn(),
	},
	createReadStream: vi.fn(),
}))

vi.mock("../../../utils/countTokens", () => ({
	countTokens: vi.fn(),
}))

const mockCountTokens = vi.mocked(countTokens)

// Get the mocked fs module
const fs = await import("fs")
const mockCreateReadStream = vi.mocked(fs.createReadStream)
const mockFsAccess = vi.mocked(fs.default.promises.access)

describe("line-counter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("countFileLinesAndTokens", () => {
		it("should count lines and tokens without budget limit", async () => {
			// Create a proper readable stream
			const mockStream = new Readable({
				read() {
					this.push("line1\n")
					this.push("line2\n")
					this.push("line3\n")
					this.push(null) // End of stream
				},
			})

			mockCreateReadStream.mockReturnValue(mockStream as any)
			mockFsAccess.mockResolvedValue(undefined)

			// Mock token counting - simulate ~10 tokens per chunk
			mockCountTokens.mockResolvedValue(30)

			const result = await countFileLinesAndTokens("/test/file.txt")

			expect(result.lineCount).toBe(3)
			expect(result.tokenEstimate).toBe(30)
			expect(result.complete).toBe(true)
		})

		it("should handle tokenizer errors with conservative estimate", async () => {
			// Create a proper readable stream
			const mockStream = new Readable({
				read() {
					this.push("line1\n")
					this.push(null)
				},
			})

			mockCreateReadStream.mockReturnValue(mockStream as any)
			mockFsAccess.mockResolvedValue(undefined)

			// Simulate tokenizer error
			mockCountTokens.mockRejectedValue(new Error("unreachable"))

			const result = await countFileLinesAndTokens("/test/file.txt")

			// Should still complete with conservative token estimate (content.length)
			expect(result.lineCount).toBe(1)
			expect(result.tokenEstimate).toBeGreaterThan(0)
			expect(result.complete).toBe(true)
		})

		it("should throw error for non-existent files", async () => {
			mockFsAccess.mockRejectedValue(new Error("ENOENT"))

			await expect(countFileLinesAndTokens("/nonexistent/file.txt")).rejects.toThrow("File not found")
		})
	})

	describe("countFileLines", () => {
		it("should throw error for non-existent files", async () => {
			mockFsAccess.mockRejectedValue(new Error("ENOENT"))

			await expect(countFileLines("/nonexistent/file.txt")).rejects.toThrow("File not found")
		})

		it("ストリームを流し切って行数を数える", async () => {
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				read() {
					this.push("line1\n")
					this.push("line2\n")
					this.push("line3\n")
					this.push(null)
				},
			})
			mockCreateReadStream.mockReturnValue(mockStream as any)

			const count = await countFileLines("/test/file.txt")

			expect(count).toBe(3)
		})

		it("ストリームがエラーを出したら reject する", async () => {
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				read() {
					this.destroy(new Error("read failed"))
				},
			})
			mockCreateReadStream.mockReturnValue(mockStream as any)

			await expect(countFileLines("/test/file.txt")).rejects.toThrow("read failed")
		})
	})

	describe("countFileLinesAndTokens（ストリーミング詳細）", () => {
		it("chunkLines ごとに逐次トークン推定し、resume して最後まで数える", async () => {
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				read() {
					for (let i = 1; i <= 5; i++) this.push(`line${i}\n`)
					this.push(null)
				},
			})
			mockCreateReadStream.mockReturnValue(mockStream as any)
			mockCountTokens.mockResolvedValue(3)

			const result = await countFileLinesAndTokens("/test/file.txt", { chunkLines: 2 })

			expect(result.lineCount).toBe(5)
			expect(result.complete).toBe(true)
			// 5 行 / chunk 2 → 途中で 2 回 + close で残り 1 回 = 計 3 回推定
			expect(mockCountTokens).toHaveBeenCalledTimes(3)
			expect(result.tokenEstimate).toBe(9)
		})

		it("予算を超えたら途中で打ち切り complete=false を返す", async () => {
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				read() {
					for (let i = 1; i <= 10; i++) this.push(`line${i}\n`)
					this.push(null)
				},
			})
			mockCreateReadStream.mockReturnValue(mockStream as any)
			// 最初のチャンクで予算超過
			mockCountTokens.mockResolvedValue(100)

			const result = await countFileLinesAndTokens("/test/file.txt", { chunkLines: 2, budgetTokens: 5 })

			expect(result.complete).toBe(false)
			expect(result.tokenEstimate).toBeGreaterThan(5)
		})

		it("処理中に close が来たら完了を待ってから解決する（destroy 失敗は reject）", async () => {
			// 予算超過の後始末で readStream.destroy() が例外を投げるケース。
			// processBuffer が reject し、行ハンドラ側の catch を通って reject が伝播する。
			// close ハンドラの「処理中は待つ」ループも同時に踏む。
			mockFsAccess.mockResolvedValue(undefined)
			// autoDestroy を切り、Node 内部の後始末で destroy が呼ばれないようにする
			// （明示的に呼んだときだけ投げさせて未処理例外を出さない）。
			const mockStream = new Readable({
				autoDestroy: false,
				read() {
					for (let i = 1; i <= 6; i++) this.push(`line${i}\n`)
					this.push(null)
				},
			})
			mockStream.destroy = () => {
				throw new Error("destroy boom")
			}
			mockCreateReadStream.mockReturnValue(mockStream as any)
			mockCountTokens.mockResolvedValue(100)

			await expect(countFileLinesAndTokens("/test/file.txt", { chunkLines: 2, budgetTokens: 5 })).rejects.toThrow(
				"destroy boom",
			)
		})

		it("close 時の残バッファ処理で destroy が失敗したら reject する", async () => {
			// chunkLines を大きくして途中処理を起こさず、close 内の processBuffer で
			// 予算超過→destroy 失敗→close ハンドラ catch を踏む。
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				autoDestroy: false,
				read() {
					this.push("only\n")
					this.push(null)
				},
			})
			mockStream.destroy = () => {
				throw new Error("close destroy boom")
			}
			mockCreateReadStream.mockReturnValue(mockStream as any)
			mockCountTokens.mockResolvedValue(100)

			await expect(
				countFileLinesAndTokens("/test/file.txt", { chunkLines: 1000, budgetTokens: 5 }),
			).rejects.toThrow("close destroy boom")
		})

		it("ストリームがエラーを出したら reject する", async () => {
			mockFsAccess.mockResolvedValue(undefined)
			const mockStream = new Readable({
				read() {
					this.destroy(new Error("stream boom"))
				},
			})
			mockCreateReadStream.mockReturnValue(mockStream as any)

			await expect(countFileLinesAndTokens("/test/file.txt")).rejects.toThrow("stream boom")
		})
	})
})
