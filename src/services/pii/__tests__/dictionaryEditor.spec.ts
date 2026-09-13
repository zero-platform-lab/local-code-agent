// npx vitest run services/pii/__tests__/dictionaryEditor.spec.ts
//
// 辞書への語の追加と、辞書の書き出し。
//
// **Shift_JIS の辞書を壊さないこと**が要点である。UTF-8 のバイト列を書き足すと、
// 1 つのファイルに 2 つの符号化が混ざって読めなくなる。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

const mocks = vi.hoisted(() => ({
	showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showQuickPick: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showSaveDialog: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	activeTextEditor: undefined as unknown,
	globalAgentDirectory: "/w/.agent",
}))

vi.mock("vscode", () => ({
	window: {
		get activeTextEditor() {
			return mocks.activeTextEditor
		},
		showInformationMessage: mocks.showInformationMessage,
		showWarningMessage: mocks.showWarningMessage,
		showQuickPick: mocks.showQuickPick,
		showSaveDialog: mocks.showSaveDialog,
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
}))

vi.mock("../../agent-config", () => ({
	getGlobalAgentDirectory: () => mocks.globalAgentDirectory,
}))

import { defaultDictionaryPath } from "../dictionary"
import { addSelectionToDictionary, canAppend, dictionaryLine, exportDictionary } from "../dictionaryEditor"

/** Shift_JIS の「田中太郎」。 */
const SJIS_TANAKA = Uint8Array.from([0x93, 0x63, 0x92, 0x86, 0x91, 0xbe, 0x98, 0x59])

const editorWith = (selected: string) => ({
	document: { getText: () => selected },
	selection: {},
})

let dir: string

beforeEach(async () => {
	vi.clearAllMocks()
	mocks.activeTextEditor = undefined
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-dict-editor-"))
	mocks.globalAgentDirectory = dir
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

const read = (target: string) => fs.readFile(target, "utf8")

describe("dictionaryLine", () => {
	it.each([
		[{ value: "サンプル", kind: "org" as const }, "サンプル\torg\n"],
		[{ value: "田中太郎", kind: "person" as const }, "田中太郎\tperson\n"],
		// term は既定なので書かない。読むほうも書かなければ term として扱う。
		[{ value: "プロジェクト葵", kind: "term" as const }, "プロジェクト葵\n"],
		[{ value: "プロジェクト葵" }, "プロジェクト葵\n"],
	])("%o は %j になる", (term, expected) => {
		expect(dictionaryLine(term)).toBe(expected)
	})
})

describe("canAppend（FR-PII-15c）", () => {
	it("まだ無いファイルには書ける", async () => {
		expect(await canAppend(path.join(dir, "無い.txt"))).toBe(true)
	})

	it("UTF-8 の辞書には書ける", async () => {
		const target = path.join(dir, "utf8.txt")
		await fs.writeFile(target, "サンプル\n", "utf8")

		expect(await canAppend(target)).toBe(true)
	})

	it("Shift_JIS の辞書には書かない", async () => {
		const target = path.join(dir, "sjis.txt")
		await fs.writeFile(target, SJIS_TANAKA)

		expect(await canAppend(target)).toBe(false)
	})
})

describe("addSelectionToDictionary", () => {
	const pickKind = (kind: string) => mocks.showQuickPick.mockResolvedValueOnce({ label: kind, termKind: kind })

	it("開いているファイルが無ければ何もしない", async () => {
		await addSelectionToDictionary()

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noEditor")
	})

	it("語が選ばれていなければ何もしない", async () => {
		mocks.activeTextEditor = editorWith("   ")

		await addSelectionToDictionary()

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noSelection")
	})

	it("辞書が無ければ既定の場所に作り、説明を先頭へ置く（FR-PII-15b）", async () => {
		mocks.activeTextEditor = editorWith("株式会社サンプル")
		pickKind("org")

		await addSelectionToDictionary()

		const written = await read(defaultDictionaryPath())
		// 書き方が分からないまま空のファイルを渡さない。
		expect(written).toContain("# マスクの辞書")
		expect(written).toContain("株式会社サンプル\torg\n")
	})

	it("2 回目は説明を重ねない", async () => {
		mocks.activeTextEditor = editorWith("サンプル")
		pickKind("org")
		await addSelectionToDictionary()
		mocks.activeTextEditor = editorWith("田中太郎")
		pickKind("person")
		await addSelectionToDictionary()

		const written = await read(defaultDictionaryPath())
		expect(written.match(/# マスクの辞書/g)).toHaveLength(1)
		expect(written).toContain("田中太郎\tperson\n")
	})

	it("辞書が 1 つなら、選ばせずにそこへ足す", async () => {
		const target = path.join(dir, "team.txt")
		await fs.writeFile(target, "既存\n", "utf8")
		mocks.activeTextEditor = editorWith("サンプル")
		pickKind("org")

		await addSelectionToDictionary({ dictionaryPaths: [target] })

		expect(await read(target)).toBe("既存\nサンプル\torg\n")
	})

	it("前の行が改行で終わっていなければ、改行を足す", async () => {
		const target = path.join(dir, "team.txt")
		// 手で編集した辞書は、末尾に改行が無いことがある。
		await fs.writeFile(target, "株式会社サンプル", "utf8")
		mocks.activeTextEditor = editorWith("田中太郎")
		pickKind("person")

		await addSelectionToDictionary({ dictionaryPaths: [target] })

		// 足さないと 1 つの語に繋がり、どちらも二度と一致しない。
		expect(await read(target)).toBe("株式会社サンプル\n田中太郎\tperson\n")
	})

	it.each([
		["2 行", "株式会社サンプル\n田中太郎"],
		["タブ入り", "株式会社\tサンプル"],
	])("%s の選択は受け付けない", async (_label, selected) => {
		const target = path.join(dir, "team.txt")
		await fs.writeFile(target, "既存\n", "utf8")
		mocks.activeTextEditor = editorWith(selected)

		await addSelectionToDictionary({ dictionaryPaths: [target] })

		expect(mocks.showWarningMessage).toHaveBeenCalledWith("common:pii.selectionNotOneTerm")
		expect(await read(target)).toBe("既存\n")
	})

	it("辞書が複数なら選ばせる（FR-PII-15a）", async () => {
		const chosen = path.join(dir, "b.txt")
		await fs.writeFile(chosen, "", "utf8")
		mocks.activeTextEditor = editorWith("サンプル")
		mocks.showQuickPick.mockResolvedValueOnce(chosen)
		pickKind("org")

		await addSelectionToDictionary({ dictionaryPaths: [path.join(dir, "a.txt"), chosen] })

		expect(await read(chosen)).toContain("サンプル\torg\n")
	})

	it("辞書を選ばずに閉じたら何もしない", async () => {
		mocks.activeTextEditor = editorWith("サンプル")
		mocks.showQuickPick.mockResolvedValueOnce(undefined)

		await addSelectionToDictionary({ dictionaryPaths: [path.join(dir, "a.txt"), path.join(dir, "b.txt")] })

		expect(mocks.showInformationMessage).not.toHaveBeenCalled()
	})

	it("種類を選ばずに閉じたら足さない", async () => {
		const target = path.join(dir, "a.txt")
		await fs.writeFile(target, "既存\n", "utf8")
		mocks.activeTextEditor = editorWith("サンプル")
		mocks.showQuickPick.mockResolvedValueOnce(undefined)

		await addSelectionToDictionary({ dictionaryPaths: [target] })

		expect(await read(target)).toBe("既存\n")
	})

	it("Shift_JIS の辞書へは書かず、その旨を出す（FR-PII-15c）", async () => {
		const target = path.join(dir, "sjis.txt")
		await fs.writeFile(target, SJIS_TANAKA)
		mocks.activeTextEditor = editorWith("サンプル")

		await addSelectionToDictionary({ dictionaryPaths: [target] })

		expect(mocks.showWarningMessage.mock.calls[0][0]).toContain("common:pii.dictionaryNotUtf8")
		// 壊さないために、1 バイトも書き足さない。
		expect(await fs.readFile(target)).toEqual(Buffer.from(SJIS_TANAKA))
	})
})

describe("exportDictionary（FR-PII-17）", () => {
	it("設定の語と辞書の語をまとめて書き出す（FR-PII-17a）", async () => {
		const source = path.join(dir, "team.txt")
		await fs.writeFile(source, "田中太郎\tperson\n", "utf8")
		const out = path.join(dir, "out.txt")
		mocks.showSaveDialog.mockResolvedValueOnce({ fsPath: out })

		await exportDictionary({ terms: [{ value: "サンプル", kind: "org" }], dictionaryPaths: [source] })

		const written = await read(out)
		expect(written).toContain("サンプル\torg\n")
		expect(written).toContain("田中太郎\tperson\n")
	})

	it("同じ語は 1 つにまとめる（FR-PII-17b）", async () => {
		const source = path.join(dir, "team.txt")
		await fs.writeFile(source, "サンプル\torg\n", "utf8")
		const out = path.join(dir, "out.txt")
		mocks.showSaveDialog.mockResolvedValueOnce({ fsPath: out })

		await exportDictionary({ terms: [{ value: "サンプル", kind: "org" }], dictionaryPaths: [source] })

		expect((await read(out)).match(/サンプル/g)).toHaveLength(1)
	})

	it("正規表現はスラッシュで囲み直す。読み戻せる形にする", async () => {
		const out = path.join(dir, "out.txt")
		mocks.showSaveDialog.mockResolvedValueOnce({ fsPath: out })

		await exportDictionary({ terms: [{ value: "EMP-\\d{5}", regex: true }] })

		expect(await read(out)).toContain("/EMP-\\d{5}/\n")
	})

	it("書き出す語が無ければ、その旨を出して保存させない", async () => {
		await exportDictionary({})

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.nothingToExport")
		expect(mocks.showSaveDialog).not.toHaveBeenCalled()
	})

	it("保存先を選ばずに閉じたら書かない", async () => {
		mocks.showSaveDialog.mockResolvedValueOnce(undefined)

		await exportDictionary({ terms: [{ value: "サンプル" }] })

		expect(mocks.showInformationMessage).not.toHaveBeenCalled()
	})
})
