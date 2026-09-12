// npx vitest run services/pii/__tests__/maskEditor.spec.ts
//
// 開いているファイルを伏せ字へ置き換えるコマンド。
//
// **戻せない操作である**（対応表を持たない）。確認を挟むこと、選択範囲を守ること、
// 失敗を黙らせないことを固定する。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

const mocks = vi.hoisted(() => ({
	showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	applyEdit: vi.fn(async (..._args: unknown[]) => true),
	activeTextEditor: undefined as unknown,
}))

/** 当てられた置き換えを読むための形。実体は `vi.mock` の中で作る。 */
type CapturedEdit = { replacements: { uri: unknown; range: unknown; text: string }[] }

// **クラスは factory の中で定義する。** factory は巻き上げられて外側の宣言より先に
// 走るため、外で定義すると初期化前の参照になる。
vi.mock("vscode", () => ({
	window: {
		get activeTextEditor() {
			return mocks.activeTextEditor
		},
		showInformationMessage: mocks.showInformationMessage,
		showWarningMessage: mocks.showWarningMessage,
		showErrorMessage: mocks.showErrorMessage,
	},
	workspace: { applyEdit: mocks.applyEdit },
	WorkspaceEdit: class {
		replacements: { uri: unknown; range: unknown; text: string }[] = []
		replace(uri: unknown, range: unknown, text: string) {
			this.replacements.push({ uri, range, text })
		}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

// 文言ではなく「どの鍵を出したか」を見る。
vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
}))

import { describeCounts, maskSecretsInActiveEditor } from "../maskEditor"

const editorWith = (text: string, selection?: { start: number; end: number }) => ({
	document: {
		uri: { fsPath: "/w/note.md" },
		getText: () => text,
		offsetAt: (position: { offset: number }) => position.offset,
		positionAt: (offset: number) => ({ offset }),
	},
	selection: selection
		? { isEmpty: false, start: { offset: selection.start }, end: { offset: selection.end } }
		: { isEmpty: true, start: { offset: 0 }, end: { offset: 0 } },
})

/** 確認の問いに「置き換える」と答える。 */
const answerConfirm = () => mocks.showWarningMessage.mockResolvedValueOnce("common:pii.confirmReplace")

beforeEach(() => {
	vi.clearAllMocks()
	mocks.applyEdit.mockResolvedValue(true)
	mocks.activeTextEditor = undefined
})

describe("describeCounts", () => {
	it("種類ごとの件数を並べる（FR-PII-11b）", () => {
		expect(describeCounts({ email: 2, address: 1 })).toBe("common:pii.kind.email 2、common:pii.kind.address 1")
	})

	it("0 件の種類は出さない", () => {
		expect(describeCounts({ email: 1, address: 0 })).toBe("common:pii.kind.email 1")
	})
})

describe("maskSecretsInActiveEditor", () => {
	it("開いているファイルが無ければ何もしない", async () => {
		await maskSecretsInActiveEditor()

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noEditor")
		expect(mocks.applyEdit).not.toHaveBeenCalled()
	})

	it("見つからなければ、その旨を出して終わる", async () => {
		mocks.activeTextEditor = editorWith("ふつうの文章")

		await maskSecretsInActiveEditor()

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.nothingFound")
		expect(mocks.applyEdit).not.toHaveBeenCalled()
	})

	it("確認を挟み、断られたら置き換えない（FR-PII-11b）", async () => {
		mocks.activeTextEditor = editorWith("連絡は taro@corp.example へ")
		mocks.showWarningMessage.mockResolvedValueOnce(undefined)

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		// 戻せない操作を、確認なしで行わない。
		expect(mocks.showWarningMessage).toHaveBeenCalledOnce()
		expect(mocks.applyEdit).not.toHaveBeenCalled()
	})

	it("承諾されたら 1 つの編集としてまとめて当てる（FR-PII-11c）", async () => {
		mocks.activeTextEditor = editorWith("taro@corp.example と hanako@corp.example")
		answerConfirm()

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		// 取り消しの操作 1 回で元へ戻るよう、WorkspaceEdit は 1 つにする。
		expect(mocks.applyEdit).toHaveBeenCalledOnce()
		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements.map((one) => one.text)).toEqual(["{{email-001}}", "{{email-002}}"])
		expect(mocks.showInformationMessage).toHaveBeenCalledWith(
			'common:pii.replaced:{"summary":"common:pii.kind.email 2"}',
		)
	})

	it("選択している範囲があれば、その中だけを対象にする（FR-PII-11a）", async () => {
		mocks.activeTextEditor = editorWith("taro@corp.example と hanako@corp.example", { start: 0, end: 17 })
		answerConfirm()

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements).toHaveLength(1)
	})

	it("当てられなかったら黙らせない", async () => {
		mocks.activeTextEditor = editorWith("taro@corp.example")
		answerConfirm()
		mocks.applyEdit.mockResolvedValue(false)

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		expect(mocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith("common:pii.replaceFailed")
		expect(mocks.showInformationMessage).not.toHaveBeenCalled()
	})

	it("挙げた語も辞書の語も使う", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-editor-"))
		const dictionary = path.join(dir, "dict.txt")
		await fs.writeFile(dictionary, "田中太郎\tperson\n", "utf8")
		mocks.activeTextEditor = editorWith("株式会社アクメの田中太郎")
		answerConfirm()

		await maskSecretsInActiveEditor({
			kinds: ["org", "person"],
			terms: [{ value: "株式会社アクメ", kind: "org" }],
			dictionaryPaths: [dictionary],
		})

		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements.map((one) => one.text)).toEqual(["{{org-001}}", "{{person-001}}"])
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("辞書が読めなくても、ほかの種類の置き換えは続ける（FR-PII-03d）", async () => {
		mocks.activeTextEditor = editorWith("taro@corp.example")
		// 辞書の警告が先に出て、そのあとに確認が来る。
		mocks.showWarningMessage.mockResolvedValueOnce(undefined)
		answerConfirm()

		await maskSecretsInActiveEditor({ kinds: ["email"], dictionaryPaths: ["/無い/辞書.txt"] })

		expect(mocks.showWarningMessage.mock.calls[0][0]).toContain("common:pii.dictionaryFailed")
		// 辞書が無いことを理由に、メールアドレスの伏せ字まで止めない。
		expect(mocks.applyEdit).toHaveBeenCalledOnce()
	})
})
