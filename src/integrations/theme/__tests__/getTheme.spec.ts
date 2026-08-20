// npx vitest run integrations/theme/__tests__/getTheme.spec.ts

import * as path from "path"

import * as vscode from "vscode"
import * as fs from "fs/promises"
import { convertTheme } from "monaco-vscode-textmate-theme-converter/lib/cjs"

import { getTheme, mergeJson } from "../getTheme"

// fs/convertTheme/vscode をモック。path は本物を使う（結合結果を検証するため）。
vi.mock("fs/promises", () => ({ readFile: vi.fn() }))
vi.mock("monaco-vscode-textmate-theme-converter/lib/cjs", () => ({ convertTheme: vi.fn() }))
vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(() => ({ get: () => undefined })) },
	extensions: { all: [], getExtension: vi.fn() },
}))

const readFileMock = vi.mocked(fs.readFile)
const convertThemeMock = vi.mocked(convertTheme)
const getConfigMock = vi.mocked(vscode.workspace.getConfiguration)
const getExtensionMock = vi.mocked(vscode.extensions.getExtension)

/** getConfiguration("workbench").get<string>("colorTheme") の戻り値を差し替える。 */
function setColorTheme(value: string | undefined) {
	getConfigMock.mockReturnValue({ get: () => value } as never)
}

/** vscode.extensions.all を差し替える。 */
function setExtensions(all: unknown[]) {
	;(vscode.extensions as unknown as { all: unknown[] }).all = all
}

beforeEach(() => {
	vi.clearAllMocks()
	setColorTheme(undefined)
	setExtensions([])
	getExtensionMock.mockReturnValue({ extensionUri: { fsPath: "/root" } } as never)
	convertThemeMock.mockReturnValue({ base: "vs-dark" } as never)
})

describe("getTheme", () => {
	it("ラベル一致する拡張のテーマを読み、コメント行を除去して base をそのまま使う", async () => {
		setColorTheme("My Theme")
		setExtensions([
			{
				extensionPath: "/ext",
				packageJSON: {
					contributes: {
						themes: [
							{ label: "Other", path: "o.json" },
							{ label: "My Theme", path: "theme.json" },
						],
					},
				},
			},
		])
		readFileMock.mockResolvedValue(
			["// これは行コメント（除去される）", "{", '  "name": "My Theme",', '  "tokenColors": []', "}"].join("\n"),
		)
		convertThemeMock.mockReturnValue({ base: "vs" } as never) // 許可リストに含まれる → そのまま

		const result = await getTheme()

		expect(readFileMock).toHaveBeenCalledWith(path.join("/ext", "theme.json"), "utf-8")
		// コメント行が除去された JSON が convertTheme に渡る。
		expect(convertThemeMock).toHaveBeenCalledWith(expect.objectContaining({ name: "My Theme", tokenColors: [] }))
		expect(result).toEqual({ base: "vs" })
	})

	it("複数の拡張が一致しても最初に見つけた一つで打ち切る（ループ先頭の break）", async () => {
		setColorTheme("Dup Theme")
		// 末尾（index 1）から走査されるため /ext1 が先に一致する。
		setExtensions([
			{
				extensionPath: "/ext0",
				packageJSON: { contributes: { themes: [{ label: "Dup Theme", path: "a.json" }] } },
			},
			{
				extensionPath: "/ext1",
				packageJSON: { contributes: { themes: [{ label: "Dup Theme", path: "b.json" }] } },
			},
		])
		readFileMock.mockResolvedValue('{"tokenColors": []}')

		await getTheme()

		// 先に一致した /ext1 だけを読み、次の反復は先頭 break で読まない。
		expect(readFileMock).toHaveBeenCalledTimes(1)
		expect(readFileMock).toHaveBeenCalledWith(path.join("/ext1", "b.json"), "utf-8")
	})

	it("colorTheme 未設定なら既定名にフォールバックし、default-themes を読む", async () => {
		setColorTheme(undefined) // `|| "Default Dark Modern"` の右側
		setExtensions([])
		readFileMock.mockResolvedValue('{"tokenColors": []}')

		const result = await getTheme()

		expect(readFileMock).toHaveBeenCalledWith(
			path.join("/root", "integrations", "theme", "default-themes", "dark_modern.json"),
			"utf-8",
		)
		expect(result).toEqual({ base: "vs-dark" }) // base 非許可リスト & 名前に Light 無し
	})

	it("parsed.include があれば include 先を読み込みマージする", async () => {
		setColorTheme("Inc Theme")
		setExtensions([
			{
				extensionPath: "/ext",
				packageJSON: { contributes: { themes: [{ label: "Inc Theme", path: "t.json" }] } },
			},
		])
		readFileMock
			.mockResolvedValueOnce('{"include": "base.json", "colors": {"a": "1"}}')
			.mockResolvedValueOnce('{"colors": {"b": "2"}, "tokenColors": []}')

		await getTheme()

		// include 先が既定テーマディレクトリから読まれる。
		expect(readFileMock).toHaveBeenNthCalledWith(
			2,
			path.join("/root", "integrations", "theme", "default-themes", "base.json"),
			"utf-8",
		)
		// マージ結果（両者の colors キー）が convertTheme に渡る。
		const passed = convertThemeMock.mock.calls[0][0] as { colors: Record<string, string> }
		expect(passed.colors).toEqual({ a: "1", b: "2" })
	})

	it("base が非許可リスト かつ 名前に Light を含むなら vs にする", async () => {
		setColorTheme("Bright Light")
		setExtensions([
			{
				extensionPath: "/ext",
				packageJSON: { contributes: { themes: [{ label: "Bright Light", path: "t.json" }] } },
			},
		])
		readFileMock.mockResolvedValue('{"tokenColors": []}')
		convertThemeMock.mockReturnValue({ base: "custom" } as never)

		const result = await getTheme()

		expect(result).toEqual({ base: "vs" })
	})

	it("どこにも一致せず既定にも無ければ空テーマを変換して返す", async () => {
		setColorTheme("Nonexistent Theme")
		setExtensions([
			// contributes.themes が空配列（length > 0 が false）
			{ extensionPath: "/e1", packageJSON: { contributes: { themes: [] } } },
			// contributes 自体が無い
			{ extensionPath: "/e2", packageJSON: {} },
		])

		const result = await getTheme()

		expect(readFileMock).not.toHaveBeenCalled()
		// parseThemeString(undefined) → {} が渡る。
		expect(convertThemeMock).toHaveBeenCalledWith({})
		expect(result).toEqual({ base: "vs-dark" })
	})

	it("読み込み中に例外が起きたら undefined を返す", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		setColorTheme("Default Dark Modern") // 既定テーマ読みへ
		setExtensions([])
		readFileMock.mockRejectedValue(new Error("boom"))

		const result = await getTheme()

		expect(result).toBeUndefined()
		expect(logSpy).toHaveBeenCalled()
		logSpy.mockRestore()
	})
})

describe("mergeJson", () => {
	it("first に無いキーは second の値を採用する", () => {
		expect(mergeJson({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 })
	})

	it("overwrite なら既存キーも second で上書きする", () => {
		expect(mergeJson({ a: 1 }, { a: 2 }, "overwrite")).toEqual({ a: 2 })
	})

	it("mergeKeys 無しの配列同士は連結する", () => {
		expect(mergeJson({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [1, 2, 3] })
	})

	it("mergeKeys ありの配列は一致したものだけ second で置き換える", () => {
		const result = mergeJson({ arr: [{ id: 1 }, { id: 2 }] }, { arr: [{ id: 2, v: "x" }] }, undefined, {
			arr: (a, b) => a.id === b.id,
		})
		// id:1 は残し、id:2 は second の項目で置換。
		expect(result).toEqual({ arr: [{ id: 1 }, { id: 2, v: "x" }] })
	})

	it("オブジェクト同士は再帰的にマージする", () => {
		expect(mergeJson({ o: { a: 1 } }, { o: { b: 2 } })).toEqual({ o: { a: 1, b: 2 } })
	})

	it("プリミティブ同士は second で上書きする", () => {
		expect(mergeJson({ a: 1 }, { a: 5 })).toEqual({ a: 5 })
	})

	it("マージ中に例外が起きたら first と second の浅いマージを返す", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const result = mergeJson({ arr: [1] }, { arr: [2] }, undefined, {
			arr: () => {
				throw new Error("boom")
			},
		})
		expect(result).toEqual({ arr: [2] }) // {...copyOfFirst, ...second}
		expect(errSpy).toHaveBeenCalled()
		errSpy.mockRestore()
	})
})
