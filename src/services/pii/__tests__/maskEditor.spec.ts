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
// 実行する人の `~/.agent/pii-dictionary.txt` を読まないようにする。読むと、その人が
// 実際に足した語で結果が変わる。
vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
}))

import { createAllocator } from "../maskText"
import { describeCounts, maskSecretsInActiveEditor, restoreSecretsInActiveEditor } from "../maskEditor"

const editorWith = (text: string, selection?: { start: number; end: number }) => ({
	document: {
		uri: { fsPath: "/w/note.md" },
		version: 1,
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

	it("会話の対応表を渡すと、その続きから番号を振る", async () => {
		const allocator = createAllocator()
		// 会話の側で 001 を別の値へ割り当て済み、という状況。
		allocator.assign("email", "alice@corp.example")
		mocks.activeTextEditor = editorWith("taro@corp.example")
		answerConfirm()

		await maskSecretsInActiveEditor({ kinds: ["email"] }, allocator)

		// 分けると、同じ形の伏せ字が別の値を指す。
		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements[0].text).toBe("{{email-002}}")
	})

	it("選択している範囲があれば、その中だけを対象にする（FR-PII-11a）", async () => {
		mocks.activeTextEditor = editorWith("taro@corp.example と hanako@corp.example", { start: 0, end: 17 })
		answerConfirm()

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements).toHaveLength(1)
	})

	it("待ちの間にファイルが変わったら当てない", async () => {
		const editor = editorWith("taro@corp.example")
		mocks.activeTextEditor = editor
		// 確認の最中に整形が走った、という状況を作る。
		mocks.showWarningMessage.mockImplementationOnce(async () => {
			editor.document.version = 2
			return "common:pii.confirmReplace"
		})

		await maskSecretsInActiveEditor({ kinds: ["email"] })

		// 古い位置へ当てると、無関係な箇所が伏せ字になり、機密情報は残る。
		expect(mocks.applyEdit).not.toHaveBeenCalled()
		expect(mocks.showWarningMessage).toHaveBeenCalledWith("common:pii.documentChanged")
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
		mocks.activeTextEditor = editorWith("株式会社サンプルの田中太郎")
		answerConfirm()

		await maskSecretsInActiveEditor({
			kinds: ["org", "person"],
			terms: [{ value: "株式会社サンプル", kind: "org" }],
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

describe("restoreSecretsInActiveEditor（FR-PII-20）", () => {
	const unmask = (text: string) => text.replace("{{email-001}}", "taro@corp.example")

	it("開いているファイルが無ければ何もしない", async () => {
		await restoreSecretsInActiveEditor(unmask)

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noEditor")
	})

	it("対応表が無ければ、戻せない旨を出す（FR-PII-20b）", async () => {
		mocks.activeTextEditor = editorWith("{{email-001}}")

		await restoreSecretsInActiveEditor(undefined)

		// 会話が終わると対応表は消える。黙って何もしないと、戻ったと思われる。
		expect(mocks.showWarningMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noVault")
		expect(mocks.applyEdit).not.toHaveBeenCalled()
	})

	it("伏せ字が無ければ書き換えない", async () => {
		mocks.activeTextEditor = editorWith("ふつうの文章")

		await restoreSecretsInActiveEditor(unmask)

		expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.nothingToRestore")
		expect(mocks.applyEdit).not.toHaveBeenCalled()
	})

	it("伏せ字を元の値へ戻す", async () => {
		mocks.activeTextEditor = editorWith("宛先は {{email-001}} です")

		await restoreSecretsInActiveEditor(unmask)

		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements[0].text).toBe("宛先は taro@corp.example です")
		expect(mocks.showInformationMessage).toHaveBeenCalledWith("common:pii.restored")
	})

	it("置き換える範囲は、いまの文書の終わりまでにする", async () => {
		const editor = editorWith("宛先は {{email-001}}")
		mocks.activeTextEditor = editor

		await restoreSecretsInActiveEditor(unmask)

		// 写しの長さで測ると、間に入った編集の分だけ足りず、末尾が二重になる。
		const edit = mocks.applyEdit.mock.calls[0][0] as CapturedEdit
		expect(edit.replacements[0].range).toMatchObject({ end: { offset: "宛先は {{email-001}}".length } })
	})

	it("当てられなかったら黙らせない", async () => {
		mocks.activeTextEditor = editorWith("{{email-001}}")
		mocks.applyEdit.mockResolvedValue(false)

		await restoreSecretsInActiveEditor(unmask)

		expect(mocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith("common:pii.replaceFailed")
	})
})
