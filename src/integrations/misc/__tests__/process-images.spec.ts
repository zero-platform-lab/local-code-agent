// npx vitest run integrations/misc/__tests__/process-images.spec.ts
//
// selectImages は「ユーザが選んだ画像ファイルを読んで data URL 化する」入口。
// C0 10.0% / 関数 0%（36 行が未実行）で、ダイアログのキャンセル・空選択・
// 未対応拡張子といった分岐が一切試されていなかった。
//
// ここで固定するのは次の 4 点:
//   1. ダイアログをキャンセル / 空選択したときにファイルを 1 度も読まないこと
//   2. 選択された順序どおりに data URL を返すこと（Promise.all の順序保証）
//   3. 拡張子 → MIME の対応表（大文字小文字を問わない）
//   4. 未対応拡張子は握りつぶさず投げること（＝壊れた data URL をモデルに渡さない）
//
// 実ファイルには一切触らない。fs/promises は丸ごとモックし、「読みに行ったパスの全件」を
// 検査できるようにしている。

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- モック定義 -------------------------------------------------------------

const { showOpenDialogMock, readFileMock } = vi.hoisted(() => ({
	showOpenDialogMock: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	readFileMock: vi.fn(async (..._args: unknown[]) => Buffer.from("")),
}))

vi.mock("vscode", () => ({
	window: { showOpenDialog: showOpenDialogMock },
}))

// 実装は `import fs from "fs/promises"` の default import なので default も生やす。
vi.mock("fs/promises", () => {
	const api = { readFile: readFileMock }
	return { ...api, default: api }
})

import { selectImages } from "../process-images"

// --- ヘルパ -----------------------------------------------------------------

/** showOpenDialog の戻り値（Uri 配列）を組み立てる。 */
const uris = (...paths: string[]) => paths.map((fsPath) => ({ fsPath }))

/** fs.readFile に渡ったパスの全件。 */
const readPaths = () => readFileMock.mock.calls.map(([p]) => p as string)

beforeEach(() => {
	vi.clearAllMocks()
	readFileMock.mockImplementation(async (p: unknown) => Buffer.from(`bytes:${String(p)}`))
})

// --- 1. ダイアログの結果 -----------------------------------------------------

describe("selectImages - ダイアログの結果", () => {
	it("複数選択・画像フィルタ付きでダイアログを開く", async () => {
		showOpenDialogMock.mockResolvedValue(undefined)

		await selectImages()

		expect(showOpenDialogMock).toHaveBeenCalledWith({
			canSelectMany: true,
			openLabel: "Select",
			filters: { Images: ["png", "jpg", "jpeg", "webp"] },
		})
	})

	it("**キャンセルされたらファイルを 1 度も読まない**", async () => {
		showOpenDialogMock.mockResolvedValue(undefined)

		expect(await selectImages()).toEqual([])
		expect(readFileMock).not.toHaveBeenCalled()
	})

	it("**空選択でもファイルを 1 度も読まない**", async () => {
		showOpenDialogMock.mockResolvedValue([])

		expect(await selectImages()).toEqual([])
		expect(readFileMock).not.toHaveBeenCalled()
	})
})

// --- 2. data URL への変換 ----------------------------------------------------

describe("selectImages - data URL への変換", () => {
	it("選択されたファイルだけを読み、base64 の data URL にする", async () => {
		showOpenDialogMock.mockResolvedValue(uris("/img/a.png"))
		readFileMock.mockResolvedValue(Buffer.from([0x01, 0x02, 0x03]))

		const result = await selectImages()

		expect(readPaths()).toEqual(["/img/a.png"])
		expect(result).toEqual([`data:image/png;base64,${Buffer.from([0x01, 0x02, 0x03]).toString("base64")}`])
	})

	it("複数選択では選択順を保つ", async () => {
		showOpenDialogMock.mockResolvedValue(uris("/img/1.png", "/img/2.jpg", "/img/3.webp"))
		// 1 番目だけ意図的に遅延させ、Promise.all が順序を保つことを確かめる
		readFileMock.mockImplementation(async (p: unknown) => {
			if (p === "/img/1.png") {
				await new Promise((resolve) => setTimeout(resolve, 20))
			}
			return Buffer.from(String(p))
		})

		const result = await selectImages()

		expect(readPaths()).toEqual(["/img/1.png", "/img/2.jpg", "/img/3.webp"])
		expect(result).toEqual([
			`data:image/png;base64,${Buffer.from("/img/1.png").toString("base64")}`,
			`data:image/jpeg;base64,${Buffer.from("/img/2.jpg").toString("base64")}`,
			`data:image/webp;base64,${Buffer.from("/img/3.webp").toString("base64")}`,
		])
	})

	const mimeCases: Array<[string, string]> = [
		["/x/a.png", "image/png"],
		["/x/a.jpg", "image/jpeg"],
		["/x/a.jpeg", "image/jpeg"],
		["/x/a.webp", "image/webp"],
		// 拡張子は toLowerCase してから判定される
		["/x/A.PNG", "image/png"],
		["/x/A.JPEG", "image/jpeg"],
		["/x/A.WebP", "image/webp"],
		// ディレクトリ名に紛らわしい拡張子があっても basename の拡張子で決まる
		["/x.gif/a.png", "image/png"],
	]

	for (const [filePath, mimeType] of mimeCases) {
		it(`拡張子 → MIME: ${filePath} → ${mimeType}`, async () => {
			showOpenDialogMock.mockResolvedValue(uris(filePath))
			readFileMock.mockResolvedValue(Buffer.from("x"))

			const [dataUrl] = await selectImages()

			expect(dataUrl).toBe(`data:${mimeType};base64,${Buffer.from("x").toString("base64")}`)
		})
	}
})

// --- 3. 失敗経路 -------------------------------------------------------------

describe("selectImages - 失敗経路", () => {
	it("**未対応の拡張子は握りつぶさず投げる**", async () => {
		// 握りつぶして空文字を返すと `data:undefined;base64,...` のような
		// 壊れた URL がモデルに渡る。ここは必ず throw であること。
		showOpenDialogMock.mockResolvedValue(uris("/img/a.gif"))

		await expect(selectImages()).rejects.toThrow("Unsupported file type: .gif")
	})

	it("拡張子が無いファイルも未対応として投げる", async () => {
		showOpenDialogMock.mockResolvedValue(uris("/img/noext"))

		await expect(selectImages()).rejects.toThrow("Unsupported file type: ")
	})

	it("読み取り失敗はそのまま伝播する", async () => {
		showOpenDialogMock.mockResolvedValue(uris("/img/a.png"))
		readFileMock.mockRejectedValue(new Error("EACCES"))

		await expect(selectImages()).rejects.toThrow("EACCES")
	})
})
