// npx vitest run integrations/misc/__tests__/image-handler.spec.ts
//
// image-handler は「data URI を一時ファイルに書き出す」「利用者が選んだ場所に画像を保存する」
// という **ディスクに書く** 2 関数。C0 7.4% / 関数 0%（87 行が未実行）で、
// 書き込み先・キャンセル・後始末といった事故が起きる側の経路が丸ごと未検証だった。
//
// ここで固定するのは次の 4 点:
//   1. **一時ファイルの書き込み先がテンポラリ領域から出ない**（os.tmpdir() 配下）。
//      writeFile / delete に渡った「全パス」を毎テスト後に検査する
//   2. **保存ダイアログをキャンセルしたら writeFile が 1 度も呼ばれない**
//   3. 一時ファイルの後始末。copy 経路は成功・失敗・後始末自体の失敗いずれでも
//      delete が呼ばれること。**一方 open 経路は delete しない**（現状の挙動＝リーク。
//      characterization test として明示的に固定する）
//   4. data URI として不正なものはディスクに触れずに弾かれること
//
// 実ファイルには一切触らない。vscode.workspace.fs を丸ごとモックし、
// 「どのパスに何バイト書いたか」を全件記録する。

import * as os from "os"
import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- モック定義 -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	writeFile: vi.fn(async (..._args: unknown[]) => undefined),
	readFile: vi.fn(async (..._args: unknown[]) => new Uint8Array()),
	deleteFile: vi.fn(async (..._args: unknown[]) => undefined),
	showErrorMessage: vi.fn((..._args: unknown[]) => undefined),
	showInformationMessage: vi.fn((..._args: unknown[]) => undefined),
	showSaveDialog: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	clipboardWriteText: vi.fn(async (..._args: unknown[]) => undefined),
	executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
	getWorkspacePath: vi.fn((..._args: unknown[]) => "/workspace" as string | undefined),
}))

vi.mock("vscode", () => ({
	Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" }) },
	workspace: {
		fs: {
			writeFile: mocks.writeFile,
			readFile: mocks.readFile,
			delete: mocks.deleteFile,
		},
	},
	window: {
		showErrorMessage: mocks.showErrorMessage,
		showInformationMessage: mocks.showInformationMessage,
		showSaveDialog: mocks.showSaveDialog,
	},
	env: { clipboard: { writeText: mocks.clipboardWriteText } },
	commands: { executeCommand: mocks.executeCommand },
}))

vi.mock("../../../i18n", () => ({
	// 実装が翻訳キーと引数をどう組んだかをそのまま観測できる形にする
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}(${JSON.stringify(args)})` : key),
}))

vi.mock("../../../utils/path", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/path")>("../../../utils/path")
	return { ...actual, getWorkspacePath: mocks.getWorkspacePath }
})

import { openImage, saveImage } from "../image-handler"

// --- ヘルパ -----------------------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`

/** モックの vscode.Uri.file が返す形。 */
const fileUri = (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" })

/** vscode.workspace.fs.writeFile に渡った (パス, 中身) の全件。 */
const writes = () => mocks.writeFile.mock.calls.map(([uri, data]) => ({ fsPath: (uri as any).fsPath, data }))

/** vscode.workspace.fs.delete に渡ったパスの全件。 */
const deletes = () => mocks.deleteFile.mock.calls.map(([uri]) => (uri as any).fsPath as string)

/** そのパスが os.tmpdir() の直下（配下）に収まっているか。 */
function isInsideTmpdir(candidate: string): boolean {
	const tmp = path.resolve(os.tmpdir())
	const resolved = path.resolve(candidate)
	return resolved === tmp || resolved.startsWith(tmp + path.sep)
}

/**
 * **書き込み・削除がテンポラリ領域から出ていないこと。**
 * TaskDeletionController.spec の「fs.rm に渡った引数の全件を検査する」と同じ役割で、
 * image-handler 側の「取り返しがつかない副作用」に相当する。
 * saveImage は利用者が選んだ場所に書くのでこの検査の対象外（個別に検証する）。
 */
function expectStaysInTmpdir(label: string) {
	for (const { fsPath } of writes()) {
		expect(isInsideTmpdir(fsPath), `${label}: writeFile が tmpdir の外へ → ${fsPath}`).toBe(true)
	}
	for (const fsPath of deletes()) {
		expect(isInsideTmpdir(fsPath), `${label}: delete が tmpdir の外へ → ${fsPath}`).toBe(true)
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getWorkspacePath.mockReturnValue("/workspace")
	mocks.writeFile.mockResolvedValue(undefined)
	mocks.readFile.mockResolvedValue(new Uint8Array(PNG_BYTES))
	mocks.deleteFile.mockResolvedValue(undefined)
	mocks.showSaveDialog.mockResolvedValue(undefined)
	mocks.executeCommand.mockResolvedValue(undefined)
	mocks.clipboardWriteText.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

// --- 1. ファイルパスとして開く経路 -------------------------------------------

describe("openImage - ファイルパス", () => {
	it("絶対パスはそのまま vscode.open に渡す", async () => {
		await openImage("/abs/pic.png")

		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", fileUri("/abs/pic.png"))
		// パス指定の経路ではディスクに何も書かない
		expect(mocks.writeFile).not.toHaveBeenCalled()
	})

	it("相対パスはワークスペース基準で解決する", async () => {
		await openImage("sub/pic.png")

		expect(mocks.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			fileUri(path.join("/workspace", "sub/pic.png")),
		)
	})

	it("ワークスペースが無ければ相対パスのまま渡す", async () => {
		mocks.getWorkspacePath.mockReturnValue(undefined)

		await openImage("sub/pic.png")

		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", fileUri("sub/pic.png"))
	})

	it("copy 指定ならファイルを開かずパスだけをクリップボードへ入れる", async () => {
		await openImage("/abs/pic.png", { values: { action: "copy" } })

		expect(mocks.clipboardWriteText).toHaveBeenCalledWith("/abs/pic.png")
		expect(mocks.showInformationMessage).toHaveBeenCalledWith("common:info.path_copied_to_clipboard")
		expect(mocks.executeCommand).not.toHaveBeenCalled()
	})

	it("copy 以外の action は通常の open として扱う", async () => {
		await openImage("/abs/pic.png", { values: { action: "open" } })

		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", fileUri("/abs/pic.png"))
		expect(mocks.clipboardWriteText).not.toHaveBeenCalled()
	})

	it("values が無い options でも落ちない", async () => {
		await openImage("/abs/pic.png", {})

		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", fileUri("/abs/pic.png"))
	})

	it("open に失敗してもエラーメッセージに変えて投げ直さない", async () => {
		mocks.executeCommand.mockRejectedValue(new Error("cannot open"))

		await expect(openImage("/abs/pic.png")).resolves.toBeUndefined()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("common:errors.error_opening_image"),
		)
	})

	it("クリップボード書き込みの失敗も同じ経路で握る", async () => {
		mocks.clipboardWriteText.mockRejectedValue(new Error("no clipboard"))

		await expect(openImage("/abs/pic.png", { values: { action: "copy" } })).resolves.toBeUndefined()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("common:errors.error_opening_image"),
		)
	})

	// data:/http:/https:/vscode-resource:/file+.vscode-resource で始まるものは
	// 「ファイルパスではない」と判定され、data URI 経路へ落ちる。
	const nonFilePathPrefixes = ["http://example.com/a.png", "https://example.com/a.png", "vscode-resource:/a.png"]

	for (const value of nonFilePathPrefixes) {
		it(`ファイルパスとして扱わない: ${value}`, async () => {
			await openImage(value)

			// data URI としても不正なので invalid_data_uri で弾かれる
			expect(mocks.executeCommand).not.toHaveBeenCalled()
			expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
		})
	}

	it("ファイルパスとして扱わない: file+.vscode-resource", async () => {
		await openImage("file+.vscode-resource/a.png")

		expect(mocks.executeCommand).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})
})

// --- 2. data URI を一時ファイルへ書き出す経路 --------------------------------

describe("openImage - data URI", () => {
	it("**書き込み先はテンポラリ領域の中で、中身は base64 をデコードしたもの**", async () => {
		await openImage(PNG_DATA_URI)

		const [write] = writes()
		expect(writes()).toHaveLength(1)
		expectStaysInTmpdir("data URI の一時ファイル")
		expect(path.dirname(write.fsPath)).toBe(os.tmpdir())
		expect(Buffer.from(write.data as Uint8Array).equals(PNG_BYTES)).toBe(true)
		expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", fileUri(write.fsPath))
	})

	it("ファイル名は temp_image_<時刻>.<拡張子> になる", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))

		await openImage(`data:image/jpeg;base64,${PNG_BYTES.toString("base64")}`)

		expect(writes()[0].fsPath).toBe(path.join(os.tmpdir(), "temp_image_1700000000000.jpeg"))
		expectStaysInTmpdir("ファイル名")
	})

	it("**拡張子は英字だけしか通らないので、パス区切りを混ぜても tmpdir を出られない**", async () => {
		// `data:image/([a-zA-Z]+);base64,` という正規表現が唯一のガード。
		// ここが緩むと `../../etc/passwd` のような拡張子で tmpdir の外に書けてしまう。
		await openImage("data:image/..%2f..%2fetc%2fpasswd;base64,AAAA")

		// そもそも正規表現に一致しないので書き込み自体が起きない
		expect(mocks.writeFile).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})

	it("data URI として不正ならディスクに触れずに弾く", async () => {
		await openImage("data:image/png;base64,")

		expect(mocks.writeFile).not.toHaveBeenCalled()
		expect(mocks.deleteFile).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})

	it("画像以外の data URI も弾く", async () => {
		await openImage("data:text/plain;base64,AAAA")

		expect(mocks.writeFile).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})

	it("一時ファイルの書き込みに失敗したら open せずエラーを出す", async () => {
		mocks.writeFile.mockRejectedValue(new Error("ENOSPC"))

		await openImage(PNG_DATA_URI)

		expect(mocks.executeCommand).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("common:errors.error_opening_image"),
		)
	})

	it("【現状の挙動】open 経路では一時ファイルを削除しない（リーク）", async () => {
		// copy 経路にしか finally での後始末が無く、既定の open 経路では
		// os.tmpdir() に temp_image_*.png が残り続ける。
		// 後始末を入れたらこのテストは落ちる（＝そのとき直したことに気付ける）。
		await openImage(PNG_DATA_URI)

		expect(writes()).toHaveLength(1)
		expect(deletes()).toEqual([])
	})
})

// --- 3. data URI の copy 経路と後始末 ----------------------------------------

describe("openImage - data URI の copy", () => {
	it("書いた一時ファイルを読み直して data URI をクリップボードへ入れる", async () => {
		mocks.readFile.mockResolvedValue(new Uint8Array(PNG_BYTES))

		await openImage(PNG_DATA_URI, { values: { action: "copy" } })

		const tempPath = writes()[0].fsPath
		expect(mocks.readFile).toHaveBeenCalledWith(fileUri(tempPath))
		expect(mocks.clipboardWriteText).toHaveBeenCalledWith(`data:image/png;base64,${PNG_BYTES.toString("base64")}`)
		expect(mocks.showInformationMessage).toHaveBeenCalledWith("common:info.image_copied_to_clipboard")
		// copy 経路では open しない
		expect(mocks.executeCommand).not.toHaveBeenCalled()
	})

	it("**成功時に一時ファイルを必ず消す**", async () => {
		await openImage(PNG_DATA_URI, { values: { action: "copy" } })

		expect(deletes()).toEqual([writes()[0].fsPath])
		expectStaysInTmpdir("copy 成功")
	})

	it("**読み取りが失敗しても一時ファイルを必ず消す**", async () => {
		mocks.readFile.mockRejectedValue(new Error("EIO"))

		await openImage(PNG_DATA_URI, { values: { action: "copy" } })

		expect(deletes()).toEqual([writes()[0].fsPath])
		expect(mocks.showErrorMessage).toHaveBeenCalledWith('common:errors.error_copying_image({"errorMessage":"EIO"})')
		expectStaysInTmpdir("copy 失敗")
	})

	it("Error 以外が投げられても文字列化してメッセージに載せる", async () => {
		mocks.readFile.mockRejectedValue("plain string failure")

		await openImage(PNG_DATA_URI, { values: { action: "copy" } })

		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.error_copying_image({"errorMessage":"plain string failure"})',
		)
		expect(deletes()).toHaveLength(1)
	})

	it("後始末そのものが失敗しても呼び出し側には伝播しない", async () => {
		mocks.deleteFile.mockRejectedValue(new Error("EBUSY"))

		await expect(openImage(PNG_DATA_URI, { values: { action: "copy" } })).resolves.toBeUndefined()

		expect(deletes()).toHaveLength(1)
		// 削除失敗は握り潰す（利用者向けエラーも出さない）
		expect(mocks.showErrorMessage).not.toHaveBeenCalled()
	})

	it("削除対象は書き込んだ一時ファイルと同一パスであること", async () => {
		await openImage(PNG_DATA_URI, { values: { action: "copy" } })

		expect(deletes()).toEqual(writes().map((w) => w.fsPath))
		expectStaysInTmpdir("書き込みと削除の一致")
	})
})

// --- 4. saveImage -----------------------------------------------------------

describe("saveImage", () => {
	const defaultUri = { fsPath: "/home/user/pic.png" } as any

	it("不正な data URI ではダイアログすら出さない", async () => {
		const result = await saveImage("not-a-data-uri", defaultUri)

		expect(result).toBeUndefined()
		expect(mocks.showSaveDialog).not.toHaveBeenCalled()
		expect(mocks.writeFile).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})

	it("data URI の形式から拡張子フィルタと既定パスを組み立てる", async () => {
		mocks.showSaveDialog.mockResolvedValue(undefined)

		await saveImage(`data:image/webp;base64,${PNG_BYTES.toString("base64")}`, defaultUri)

		expect(mocks.showSaveDialog).toHaveBeenCalledWith({
			filters: { Images: ["webp"], "All Files": ["*"] },
			defaultUri,
		})
	})

	it("**保存ダイアログをキャンセルしたら writeFile が 1 度も呼ばれない**", async () => {
		// ここが抜けると「保存しない」を選んだのにファイルが作られる。
		mocks.showSaveDialog.mockResolvedValue(undefined)

		const result = await saveImage(PNG_DATA_URI, defaultUri)

		expect(result).toBeUndefined()
		expect(mocks.writeFile).not.toHaveBeenCalled()
		expect(mocks.showInformationMessage).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).not.toHaveBeenCalled()
	})

	it("選ばれた場所に、その場所だけへ書き込む", async () => {
		const saveUri = { fsPath: "/home/user/out.png" }
		mocks.showSaveDialog.mockResolvedValue(saveUri)

		const result = await saveImage(PNG_DATA_URI, defaultUri)

		expect(result).toBe(saveUri)
		expect(writes()).toHaveLength(1)
		expect(mocks.writeFile.mock.calls[0][0]).toBe(saveUri)
		expect(Buffer.from(writes()[0].data as Uint8Array).equals(PNG_BYTES)).toBe(true)
		expect(mocks.showInformationMessage).toHaveBeenCalledWith(
			'common:info.image_saved({"path":"/home/user/out.png"})',
		)
	})

	it("書き込みに失敗したら undefined を返してエラーを出す", async () => {
		mocks.showSaveDialog.mockResolvedValue({ fsPath: "/ro/out.png" })
		mocks.writeFile.mockRejectedValue(new Error("EROFS"))

		const result = await saveImage(PNG_DATA_URI, defaultUri)

		expect(result).toBeUndefined()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.error_saving_image({"errorMessage":"EROFS"})',
		)
	})

	it("Error 以外が投げられても文字列化してメッセージに載せる", async () => {
		mocks.showSaveDialog.mockResolvedValue({ fsPath: "/ro/out.png" })
		mocks.writeFile.mockRejectedValue({ code: "EROFS" })

		const result = await saveImage(PNG_DATA_URI, defaultUri)

		expect(result).toBeUndefined()
		expect(mocks.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.error_saving_image({"errorMessage":"[object Object]"})',
		)
	})
})
