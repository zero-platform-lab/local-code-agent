// npx vitest run integrations/terminal/__tests__/OutputInterceptor.invariants.spec.ts
//
// OutputInterceptor.test.ts が拾えていない端の分岐を埋める:
//   - UTF-8 のバイト境界がマルチバイト文字の途中に来たときの頭/尾スライス
//   - tail 予算が 0 のときの防御分岐（現行の preview サイズ定数では到達不能なので
//     private を直接叩いて論理だけ検証する）
//   - cleanupByIds の「存在しないディレクトリ」握りつぶしと、cmd-\d+ 以外のファイル無視
//
// 実ファイルは書かない。fs は全てモック。

import * as fs from "fs"
import * as path from "path"
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

import { OutputInterceptor } from "../OutputInterceptor"

vi.mock("fs", () => {
	const api = {
		existsSync: vi.fn(() => true),
		mkdirSync: vi.fn(),
		createWriteStream: vi.fn(),
		promises: {
			readdir: vi.fn(),
			unlink: vi.fn(),
		},
	}
	return { ...api, default: api }
})

const storageDir = path.normalize("/tmp/oi-inv")

function makeInterceptor(previewSize: "small" | "medium" | "large" = "small") {
	return new OutputInterceptor({
		executionId: "1",
		taskId: "task-1",
		command: "echo test",
		storageDir,
		previewSize,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(fs.existsSync).mockReturnValue(true)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("OutputInterceptor - UTF-8 バイト境界のスライス", () => {
	it("sliceByBytes: マルチバイト文字が境界を跨ぐと直前で切る", () => {
		const interceptor = makeInterceptor()
		// "xx" は 2 バイト。3 バイト目以降に 3 バイトの「あ」が来ると maxBytes=3 を跨ぐ。
		const result = (interceptor as unknown as { sliceByBytes(s: string, n: number): string }).sliceByBytes(
			"xxあ",
			3,
		)
		expect(result).toBe("xx")
	})

	it("sliceByBytesFromEnd: 末尾から見てマルチバイト文字が境界を跨ぐと直前で切る", () => {
		const interceptor = makeInterceptor()
		const result = (
			interceptor as unknown as { sliceByBytesFromEnd(s: string, n: number): string }
		).sliceByBytesFromEnd("あxx", 3)
		expect(result).toBe("xx")
	})

	it("write 経由でも head 境界のマルチバイト分割で壊れない", () => {
		const interceptor = makeInterceptor("small") // head 予算 2560B
		// head 予算のちょうど境界に 3 バイト文字を置く
		interceptor.write("x".repeat(2559) + "あ" + "y".repeat(10))
		const buffer = interceptor.getBufferForUI()
		// 破損せず、先頭は x、末尾側に y が残る
		expect(buffer.startsWith("x")).toBe(true)
		expect(buffer.includes("y")).toBe(true)
	})
})

describe("OutputInterceptor - tail 予算 0 の防御分岐", () => {
	it("tailBudget=0 なら tail に回すぶんは全て omitted 扱いになる", () => {
		// 現行の preview サイズ定数では tailBudget は常に >= 2560。到達不能な防御分岐を
		// private 直叩きで論理だけ固定する（omittedBytes に加算されて捨てられる）。
		const interceptor = makeInterceptor()
		;(interceptor as unknown as { tailBudget: number }).tailBudget = 0
		;(interceptor as unknown as { addToTailBuffer(c: string, n: number): void }).addToTailBuffer("abc", 3)

		expect((interceptor as unknown as { omittedBytes: number }).omittedBytes).toBe(3)
		expect((interceptor as unknown as { tailBuffer: string }).tailBuffer).toBe("")
	})
})

describe("OutputInterceptor - cleanupByIds の端の分岐", () => {
	it("ディレクトリが無ければ握りつぶす", async () => {
		vi.mocked(fs.promises.readdir).mockRejectedValue(new Error("ENOENT") as never)

		await expect(OutputInterceptor.cleanupByIds(storageDir, new Set(["1"]))).resolves.toBeUndefined()
		expect(fs.promises.unlink).not.toHaveBeenCalled()
	})

	it("cmd-<数字>.txt 以外は無視し、保持 ID 以外だけ消す", async () => {
		const files = ["cmd-100.txt", "cmd-200.txt", "notes.txt", "cmd-abc.txt"]
		vi.mocked(fs.promises.readdir).mockResolvedValue(files as never)
		vi.mocked(fs.promises.unlink).mockResolvedValue(undefined as never)

		await OutputInterceptor.cleanupByIds(storageDir, new Set(["100"]))

		// 200 だけ削除。notes.txt / cmd-abc.txt はパターン不一致で対象外。100 は保持。
		expect(fs.promises.unlink).toHaveBeenCalledTimes(1)
		expect(fs.promises.unlink).toHaveBeenCalledWith(path.join(storageDir, "cmd-200.txt"))
	})
})
