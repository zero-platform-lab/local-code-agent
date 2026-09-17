import * as vscode from "vscode"

const mocks = vi.hoisted(() => {
	const files = new Map<string, Uint8Array>()
	const secrets = new Map<string, string>()
	return {
		files,
		secrets,
		activeTextEditor: undefined as unknown,
		workspaceFolder: undefined as unknown,
		workspaceFolders: [] as { index: number; uri: { path: string } }[],
		renameListener: undefined as unknown,
		deleteListener: undefined as unknown,
		showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
		showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
		showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
		showQuickPick: vi.fn(async (..._args: unknown[]) => undefined as unknown),
		/** 設定すると、ディスクの読み書きがこの名前の例外で失敗する。 */
		ioError: undefined as string | undefined,
	}
})

vi.mock("vscode", () => ({
	window: {
		get activeTextEditor() {
			return mocks.activeTextEditor
		},
		showInformationMessage: mocks.showInformationMessage,
		showWarningMessage: mocks.showWarningMessage,
		showErrorMessage: mocks.showErrorMessage,
		showQuickPick: mocks.showQuickPick,
	},
	workspace: {
		getWorkspaceFolder: () => mocks.workspaceFolder,
		get workspaceFolders() {
			return mocks.workspaceFolders
		},
		onDidRenameFiles(listener: unknown) {
			mocks.renameListener = listener
			return { dispose() {} }
		},
		onDidDeleteFiles(listener: unknown) {
			mocks.deleteListener = listener
			return { dispose() {} }
		},
		asRelativePath: (uri: { path: string }) => uri.path.replace(/^\/w\//, ""),
		fs: {
			async stat(uri: { path: string }) {
				if (uri.path.startsWith("/w/")) return { type: 1 }
				const error = new Error(uri.path)
				error.name = "FileNotFound"
				throw error
			},
			async readFile(uri: { path: string }) {
				if (mocks.ioError) throw new Error(mocks.ioError)
				const value = mocks.files.get(uri.path)
				if (value) return value
				const error = new Error(uri.path)
				error.name = "FileNotFound"
				throw error
			},
			async writeFile(uri: { path: string }, value: Uint8Array) {
				if (mocks.ioError) throw new Error(mocks.ioError)
				mocks.files.set(uri.path, Uint8Array.from(value))
			},
			async createDirectory() {},
			async rename(from: { path: string }, to: { path: string }) {
				const value = mocks.files.get(from.path)
				if (!value) throw new Error("missing temporary file")
				mocks.files.set(to.path, value)
				mocks.files.delete(from.path)
			},
			async delete(uri: { path: string }) {
				mocks.files.delete(uri.path)
			},
		},
	},
	Uri: {
		joinPath(base: { path: string }, ...parts: string[]) {
			return { path: [base.path.replace(/\/$/, ""), ...parts].join("/") }
		},
	},
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
}))

import { FileVaultController, fileVaultIdentity } from "../fileVault"
import { PiiVault } from "../maskConversation"

const uri = (path: string) => ({ path }) as vscode.Uri
const context = () => ({
	storageUri: uri("/state"),
	secrets: {
		get: async (key: string) => mocks.secrets.get(key),
		store: async (key: string, value: string) => {
			mocks.secrets.set(key, value)
		},
	},
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.files.clear()
	mocks.secrets.clear()
	mocks.workspaceFolder = { index: 0, uri: uri("/w") }
	mocks.workspaceFolders = [mocks.workspaceFolder as never]
	mocks.renameListener = undefined
	mocks.deleteListener = undefined
	mocks.ioError = undefined
	mocks.activeTextEditor = {
		document: { uri: uri("/w/note.md"), getText: () => "連絡先は {{email-005}}" },
	}
})

describe("fileVaultIdentity", () => {
	it("ワークスペース内では相対パスだけを識別情報にする", () => {
		expect(fileVaultIdentity(uri("/w/docs/note.md"))).toBe("0:docs/note.md")
	})

	it("ワークスペース外とワークスペース自体は扱わない", () => {
		expect(fileVaultIdentity(uri("/outside/note.md"))).toBeUndefined()
		expect(fileVaultIdentity(uri("/w"))).toBeUndefined()
	})
})

describe("FileVaultController", () => {
	it("ファイル道具の相対パスから読み、衝突した番号を直す", async () => {
		const stored = new PiiVault()
		stored.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		const controller = new FileVaultController(context())
		await controller.enable(stored)

		const session = new PiiVault()
		session.importEntries([["{{email-005}}", "bob@corp.example"]])
		const remap = await controller.prepareToolPath("note.md", session)

		expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-006}}")
		expect(session.restore("{{email-006}}")).toBe("alice@corp.example")
	})

	it("添付ファイルの URI から読み、衝突した番号を直す", async () => {
		const stored = new PiiVault()
		stored.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		const controller = new FileVaultController(context())
		await controller.enable(stored)

		const session = new PiiVault()
		session.importEntries([["{{email-005}}", "bob@corp.example"]])
		const remap = await controller.prepareReference(uri("/w/note.md"), session)

		expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-006}}")
		expect(session.restore("{{email-006}}")).toBe("alice@corp.example")
	})

	it("有効化した対応を次のセッションへ取り込み、復元する", async () => {
		const first = new PiiVault()
		first.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")

		await new FileVaultController(context()).enable(first)

		const second = new PiiVault()
		const controller = new FileVaultController(context())
		expect(await controller.prepare(uri("/w/note.md"), second)).toBe(true)
		expect(second.restore("{{email-005}}")).toBe("alice@corp.example")
		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("alice@corp.example")
	})

	it("消去すると対象ファイルへの追記を再び有効化しない", async () => {
		const vault = new PiiVault()
		vault.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		const controller = new FileVaultController(context())
		await controller.enable(vault)
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.clearVault")

		await controller.disable()
		await controller.record(uri("/w/note.md"), [["{{email-006}}", "bob@corp.example"]])

		await controller.status()
		expect(mocks.showInformationMessage).toHaveBeenLastCalledWith(
			'common:pii.fileVault.notEnabled:{"file":"note.md"}',
		)
	})

	it("暗号文が壊れていれば伏せ字化を止めて理由を表示する", async () => {
		const vault = new PiiVault()
		vault.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		const controller = new FileVaultController(context())
		await controller.enable(vault)
		mocks.files.set("/state/file-vault.v1.json", new TextEncoder().encode("broken"))

		expect(await controller.prepare(uri("/w/note.md"), new PiiVault())).toBe(false)
		expect(mocks.showErrorMessage).toHaveBeenLastCalledWith("common:pii.fileVault.corrupt")
	})

	it("VS Code の名前変更と削除通知へ追従する", async () => {
		const vault = new PiiVault()
		vault.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		const controller = new FileVaultController(context())
		await controller.enable(vault)
		controller.start()

		await (mocks.renameListener as (event: unknown) => Promise<void>)({
			files: [{ oldUri: uri("/w/note.md"), newUri: uri("/w/moved.md") }],
		})
		await vi.waitFor(async () => {
			expect(await controller.restore(uri("/w/moved.md"), "{{email-005}}", (text) => text)).toBe(
				"alice@corp.example",
			)
		})

		await (mocks.deleteListener as (event: unknown) => Promise<void>)({ files: [uri("/w/moved.md")] })
		await vi.waitFor(async () => {
			expect(await controller.restore(uri("/w/moved.md"), "{{email-005}}", (text) => text)).toBe("{{email-005}}")
		})
	})

	describe("VS Code の通知への追従", () => {
		/** 1 つ有効にして、通知の受け口を開く。 */
		const started = async () => {
			const controller = new FileVaultController(context())
			const stored = new PiiVault()
			stored.importEntries([["{{email-005}}", "alice@corp.example"]])
			mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
			await controller.enable(stored)
			const disposables = controller.start()
			mocks.showInformationMessage.mockReset()
			mocks.showWarningMessage.mockReset()
			return { controller, disposables }
		}

		it("ワークスペースの外へ動かされたら、保管庫は消す", async () => {
			// **追えなくなったものを残さない。** 残すと、同じ相対パスに別のファイルが
			// 置かれたとき、別のファイルの対応表として読まれる。
			const { controller } = await started()

			await (mocks.renameListener as (event: unknown) => unknown)({
				files: [{ oldUri: uri("/w/note.md"), newUri: uri("/outside/note.md") }],
			})
			await controller.status()

			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.notEnabled"),
			)
		})

		it("消えたファイルは掃除し、読めないだけのものは残す", async () => {
			// **「無い」と「読めない」を取り違えない。** 取り違えると、ディスクの不調で
			// 一時的に読めないだけの保管庫を消してしまう。**消せばもう戻せない。**
			const { controller } = await started()
			// `stat` が「無い」以外で失敗する状態にする。
			const original = vscode.workspace.fs.stat
			;(vscode.workspace.fs as { stat: unknown }).stat = async () => {
				throw new Error("ディスクが不調")
			}

			try {
				await controller.cleanup()
				await controller.status()
			} finally {
				;(vscode.workspace.fs as { stat: unknown }).stat = original
			}

			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.statusEnabled"),
			)
		})

		it("識別できないファイルの削除は、何も壊さない", async () => {
			const { controller } = await started()

			await (mocks.deleteListener as (event: unknown) => unknown)({ files: [uri("/outside/note.md")] })
			await controller.status()

			// 別のファイルの保管庫を巻き添えにしない。
			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.statusEnabled"),
			)
		})

		it("通知の処理が失敗したら、理由を出す", async () => {
			const { controller } = await started()
			void controller
			mocks.ioError = "ディスクが読めない"

			await (mocks.deleteListener as (event: unknown) => unknown)({ files: [uri("/w/note.md")] })
			// 受け口は待たないので、次の間で片付く。
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
		})

		it("起動時の掃除が失敗しても、通知の受け口は開く", async () => {
			// **掃除の失敗で追従まで止めない。** 止めると、名前が変わった保管庫が残り続ける。
			const controller = new FileVaultController(context())
			mocks.ioError = "ディスクが読めない"

			const disposables = controller.start()

			expect(disposables).toHaveLength(2)
		})
	})

	describe("ファイル道具の道筋", () => {
		it("遡る道筋は扱わない", async () => {
			// **`..` を通すと、ワークスペースの外のファイルを指せる。** 指せると、その
			// ファイルの対応表を読み書きしかねない。
			const controller = new FileVaultController(context())

			for (const bad of ["../外.md", "a/../../外.md", "./note.md", "a//b.md", "  "]) {
				const remap = await controller.prepareToolPath(bad, new PiiVault())
				// 扱わないので、何も置き換えない関数が返る。
				expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-005}}")
				expect(await controller.recordToolPath(bad, [])).toBe(true)
			}
		})

		it("フォルダが 2 つ以上なら、先頭がフォルダ名でなければ扱わない", async () => {
			mocks.workspaceFolders = [
				{ index: 0, uri: uri("/w"), name: "w" },
				{ index: 1, uri: uri("/x"), name: "x" },
			] as never
			const controller = new FileVaultController(context())

			// どのフォルダのものか決められない。
			const remap = await controller.prepareToolPath("note.md", new PiiVault())
			expect(remap("{{email-005}}")).toBe("{{email-005}}")
		})
	})

	describe("失敗したら、理由を出して黙らない", () => {
		it("読めなければ、有効化を止めて理由を出す", async () => {
			const controller = new FileVaultController(context())
			const stored = new PiiVault()
			stored.importEntries([["{{email-005}}", "alice@corp.example"]])
			mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
			await controller.enable(stored)

			mocks.showErrorMessage.mockClear()
			mocks.ioError = "ディスクが読めない"

			await controller.enable(new PiiVault())

			expect(mocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith("common:pii.fileVault.failed")
		})

		it("書き足せなければ、成功したと言わない", async () => {
			// **`false` を返す。** 返さないと、呼んだ側は保存できたつもりで進む。
			const controller = new FileVaultController(context())
			mocks.ioError = "ディスクが読めない"

			expect(await controller.record(uri("/w/note.md"), [])).toBe(false)
			expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
		})

		it("読み込めなければ、伏せ字の予約も成功したと言わない", async () => {
			const controller = new FileVaultController(context())
			mocks.ioError = "ディスクが読めない"

			expect(await controller.prepare(uri("/w/note.md"), new PiiVault())).toBe(false)
			expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
		})

		it.each([
			["無効化", (c: FileVaultController) => c.disable()],
			["確認", (c: FileVaultController) => c.status()],
			["一覧からの消去", (c: FileVaultController) => c.clearSelected()],
			["全消去", (c: FileVaultController) => c.clearAll()],
		])("%s が失敗したら、理由を出す", async (_name, run) => {
			// **どの操作でも黙らない。** 画面が変わらないので、出さないと「消えた」
			// 「残っている」を取り違える。
			const controller = new FileVaultController(context())
			const stored = new PiiVault()
			stored.importEntries([["{{email-005}}", "alice@corp.example"]])
			mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
			await controller.enable(stored)

			mocks.showErrorMessage.mockClear()
			mocks.ioError = "ディスクが読めない"

			await run(controller)

			expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
		})
	})

	describe("使える状態でないときは、黙って何もしない形にしない", () => {
		it("開いているファイルが無ければ、その旨を出す", async () => {
			mocks.activeTextEditor = undefined
			const controller = new FileVaultController(context())

			await controller.enable(new PiiVault())

			expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith("common:pii.noEditor")
			expect(mocks.showWarningMessage).not.toHaveBeenCalled()
		})

		it("ワークスペース外のファイルでは、理由を出して止まる", async () => {
			// **外のファイルは識別できない。** 識別できないまま有効にすると、別のファイルの
			// 対応表を読み込みかねない。
			mocks.workspaceFolder = undefined
			mocks.activeTextEditor = {
				document: { uri: uri("/outside/note.md"), getText: () => "本文" },
			}
			const controller = new FileVaultController(context())

			await controller.enable(new PiiVault())

			expect(mocks.showWarningMessage).toHaveBeenCalledExactlyOnceWith("common:pii.fileVault.workspaceRequired")
		})

		it("保存先が無い環境では、一覧の操作も理由を出す", async () => {
			// `storageUri` が無いのは、フォルダを開いていないときである。
			const controller = new FileVaultController({ ...context(), storageUri: undefined })

			await controller.clearSelected()
			await controller.clearAll()

			expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2)
			expect(mocks.showWarningMessage).toHaveBeenCalledWith("common:pii.fileVault.workspaceRequired")
		})

		it("1 つも無ければ、消すものが無いと出す", async () => {
			const controller = new FileVaultController(context())

			await controller.clearSelected()
			await controller.clearAll()

			expect(mocks.showInformationMessage).toHaveBeenCalledTimes(2)
			expect(mocks.showInformationMessage).toHaveBeenCalledWith("common:pii.fileVault.none")
			// 何も無いのに確認を出さない。
			expect(mocks.showWarningMessage).not.toHaveBeenCalled()
		})

		it("既に有効なら、二重に作らず取り込む", async () => {
			const first = new PiiVault()
			first.importEntries([["{{email-005}}", "alice@corp.example"]])
			mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
			const controller = new FileVaultController(context())
			await controller.enable(first)
			mocks.showWarningMessage.mockReset()

			// 2 回目。確認は出さず、保存済みの対応を取り込む。
			const second = new PiiVault()
			await controller.enable(second)

			expect(mocks.showWarningMessage).not.toHaveBeenCalled()
			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.alreadyEnabled"),
			)
			expect(second.restore("{{email-005}}")).toBe("alice@corp.example")
		})

		it("有効でないファイルを無効化しても、理由を出すだけ", async () => {
			const controller = new FileVaultController(context())

			await controller.disable()

			expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining("common:pii.fileVault.notEnabled"),
			)
			expect(mocks.showWarningMessage).not.toHaveBeenCalled()
		})
	})

	// **確認を断ったときに何も起きないことを確かめる。**
	//
	// ここを間違えると、断ったのに消える（伏せたファイルを二度と戻せない）か、消したのに
	// 残る（消したつもりの値がディスクに残る）。**どちらも画面には何も出ない。**
	describe("確認を断ったら、何も変えない", () => {
		/** 1 つ有効にしておく。 */
		const enableOne = async (controller: FileVaultController) => {
			const stored = new PiiVault()
			stored.importEntries([["{{email-005}}", "alice@corp.example"]])
			mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
			await controller.enable(stored)
			mocks.showWarningMessage.mockReset()
			mocks.showInformationMessage.mockReset()
		}

		it("有効化を断れば、保管庫を作らない", async () => {
			const controller = new FileVaultController(context())
			// 確認の窓で何も選ばずに閉じた。
			mocks.showWarningMessage.mockResolvedValueOnce(undefined)

			await controller.enable(new PiiVault())
			await controller.status()

			expect(mocks.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining("common:pii.fileVault.notEnabled"),
			)
		})

		it("無効化を断れば、保管庫を消さない", async () => {
			const controller = new FileVaultController(context())
			await enableOne(controller)
			mocks.showWarningMessage.mockResolvedValueOnce(undefined)

			await controller.disable()
			await controller.status()

			// **残っている。** 消えていれば、伏せたファイルを二度と戻せない。
			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.statusEnabled"),
			)
		})

		it("全消去を断れば、ファイルもセッションも消さない", async () => {
			const controller = new FileVaultController(context())
			await enableOne(controller)
			const session = new PiiVault()
			session.assign("email", "bob@corp.example")
			mocks.showWarningMessage.mockResolvedValueOnce(undefined)

			await controller.clearAll(session)

			expect(session.size).toBe(1)
			await controller.status()
			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.statusEnabled"),
			)
		})

		it("一覧で選んでも、確認を断れば消さない", async () => {
			const controller = new FileVaultController(context())
			await enableOne(controller)
			mocks.showQuickPick.mockResolvedValueOnce([{ identity: "0:note.md", count: 1 }])
			mocks.showWarningMessage.mockResolvedValueOnce(undefined)

			await controller.clearSelected()
			await controller.status()

			expect(mocks.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("common:pii.fileVault.statusEnabled"),
			)
		})

		it("一覧で 1 つも選ばなければ、確認すら出さない", async () => {
			const controller = new FileVaultController(context())
			await enableOne(controller)
			mocks.showQuickPick.mockResolvedValueOnce([])

			await controller.clearSelected()

			expect(mocks.showWarningMessage).not.toHaveBeenCalled()
		})
	})

	it("一覧から選んだ File Vault だけを確認後に消去する", async () => {
		const controller = new FileVaultController(context())
		const first = new PiiVault()
		first.importEntries([["{{email-005}}", "alice@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		await controller.enable(first)

		mocks.activeTextEditor = {
			document: { uri: uri("/w/other.md"), getText: () => "{{email-006}}" },
		}
		const second = new PiiVault()
		second.importEntries([["{{email-006}}", "bob@corp.example"]])
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.fileVault.enable")
		await controller.enable(second)

		mocks.showQuickPick.mockImplementationOnce(async (value: unknown) => {
			const items = value as { label: string }[]
			return items.filter((item) => item.label === "note.md")
		})
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.clearVault")
		await controller.clearSelected()

		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("{{email-005}}")
		expect(await controller.restore(uri("/w/other.md"), "{{email-006}}", (text) => text)).toBe("bob@corp.example")
	})
})
