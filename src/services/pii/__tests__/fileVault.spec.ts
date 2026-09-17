import * as vscode from "vscode"

const mocks = vi.hoisted(() => {
	const files = new Map<string, Uint8Array>()
	const secrets = new Map<string, string>()
	return {
		files,
		secrets,
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

type Entry = readonly [string, string]

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
const alice: Entry = ["{{email-005}}", "alice@corp.example"]

beforeEach(() => {
	vi.clearAllMocks()
	mocks.files.clear()
	mocks.secrets.clear()
	mocks.workspaceFolder = { index: 0, uri: uri("/w") }
	mocks.workspaceFolders = [mocks.workspaceFolder as never]
	mocks.renameListener = undefined
	mocks.deleteListener = undefined
	mocks.ioError = undefined
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

describe("FileVaultController — 保存と取り込み", () => {
	it("読んだファイルの対応を保存し、次のセッションへ取り込み、復元する", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])

		const second = new PiiVault()
		expect(await controller.prepare(uri("/w/note.md"), second)).toBe(true)
		expect(second.restore("{{email-005}}")).toBe("alice@corp.example")
		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("alice@corp.example")
	})

	it("同じファイルへ足し合わせる（upsert）", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])
		await controller.record(uri("/w/note.md"), [["{{person-001}}", "森下"]])

		const vault = new PiiVault()
		await controller.prepare(uri("/w/note.md"), vault)
		expect(vault.restore("{{email-005}}")).toBe("alice@corp.example")
		expect(vault.restore("{{person-001}}")).toBe("森下")
	})

	it("伏せ字が無ければ保存しない", async () => {
		const controller = new FileVaultController(context())
		expect(await controller.record(uri("/w/note.md"), [])).toBe(true)
		expect(mocks.files.has("/state/file-vault.v1.json")).toBe(false)
	})

	it("ファイル道具の相対パスから読み、衝突した番号を直す", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])

		const session = new PiiVault()
		session.importEntries([["{{email-005}}", "bob@corp.example"]])
		const remap = await controller.prepareToolPath("note.md", session)

		expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-006}}")
		expect(session.restore("{{email-006}}")).toBe("alice@corp.example")
	})

	it("添付ファイルの URI から読み、衝突した番号を直す", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])

		const session = new PiiVault()
		session.importEntries([["{{email-005}}", "bob@corp.example"]])
		const remap = await controller.prepareReference(uri("/w/note.md"), session)

		expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-006}}")
		expect(session.restore("{{email-006}}")).toBe("alice@corp.example")
	})
})

describe("VS Code の通知への追従", () => {
	it("名前変更に追い、削除で消す", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])
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

	it("ワークスペースの外へ動いたら消す", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])
		controller.start()

		await (mocks.renameListener as (event: unknown) => Promise<void>)({
			files: [{ oldUri: uri("/w/note.md"), newUri: uri("/outside/note.md") }],
		})
		await vi.waitFor(async () => {
			expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("{{email-005}}")
		})
	})

	it("起動時の掃除が失敗しても、通知の受け口は開く", async () => {
		const controller = new FileVaultController(context())
		mocks.ioError = "ディスクが読めない"
		expect(controller.start()).toHaveLength(2)
	})
})

describe("ファイル道具の道筋", () => {
	it("遡る道筋は扱わない", async () => {
		const controller = new FileVaultController(context())
		for (const bad of ["../外.md", "a/../../外.md", "./note.md", "a//b.md", "  "]) {
			const remap = await controller.prepareToolPath(bad, new PiiVault())
			expect(remap("連絡先は {{email-005}}")).toBe("連絡先は {{email-005}}")
			expect(await controller.recordToolPath(bad, [alice])).toBe(true)
		}
		expect(mocks.files.has("/state/file-vault.v1.json")).toBe(false)
	})

	it("フォルダが 2 つ以上なら、先頭がフォルダ名でなければ扱わない", async () => {
		mocks.workspaceFolders = [
			{ index: 0, uri: uri("/w"), name: "w" },
			{ index: 1, uri: uri("/x"), name: "x" },
		] as never
		const controller = new FileVaultController(context())
		const remap = await controller.prepareToolPath("note.md", new PiiVault())
		expect(remap("{{email-005}}")).toBe("{{email-005}}")
	})
})

describe("失敗したら、理由を出して黙らない", () => {
	it("書けなければ false を返し、理由を出す", async () => {
		const controller = new FileVaultController(context())
		mocks.ioError = "ディスクが読めない"
		expect(await controller.record(uri("/w/note.md"), [alice])).toBe(false)
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
	})

	it("読めなければ、取り込みも成功したと言わない", async () => {
		const controller = new FileVaultController(context())
		mocks.ioError = "ディスクが読めない"
		expect(await controller.prepare(uri("/w/note.md"), new PiiVault())).toBe(false)
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:pii.fileVault.failed")
	})

	it("暗号文が壊れていれば止めて理由を出す", async () => {
		const controller = new FileVaultController(context())
		await controller.record(uri("/w/note.md"), [alice])
		mocks.files.set("/state/file-vault.v1.json", new TextEncoder().encode("broken"))

		expect(await controller.prepare(uri("/w/note.md"), new PiiVault())).toBe(false)
		expect(mocks.showErrorMessage).toHaveBeenLastCalledWith("common:pii.fileVault.corrupt")
	})
})

describe("消去", () => {
	const saveOne = (controller: FileVaultController) => controller.record(uri("/w/note.md"), [alice])

	it("保存先が無い環境では、理由を出す", async () => {
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
		expect(mocks.showWarningMessage).not.toHaveBeenCalled()
	})

	it("一覧から選んだファイルだけを確認後に消す", async () => {
		const controller = new FileVaultController(context())
		await saveOne(controller)
		await controller.record(uri("/w/other.md"), [["{{email-006}}", "bob@corp.example"]])

		mocks.showQuickPick.mockImplementationOnce(async (value: unknown) => {
			const items = value as { label: string }[]
			return items.filter((item) => item.label === "note.md")
		})
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.clearVault")
		await controller.clearSelected()

		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("{{email-005}}")
		expect(await controller.restore(uri("/w/other.md"), "{{email-006}}", (text) => text)).toBe("bob@corp.example")
	})

	it("一覧の確認を断れば、消さない", async () => {
		const controller = new FileVaultController(context())
		await saveOne(controller)
		mocks.showQuickPick.mockResolvedValueOnce([{ identity: "0:note.md", count: 1 }])
		mocks.showWarningMessage.mockResolvedValueOnce(undefined)

		await controller.clearSelected()

		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("alice@corp.example")
	})

	it("一覧で 1 つも選ばなければ、確認すら出さない", async () => {
		const controller = new FileVaultController(context())
		await saveOne(controller)
		mocks.showQuickPick.mockResolvedValueOnce([])
		await controller.clearSelected()
		expect(mocks.showWarningMessage).not.toHaveBeenCalled()
	})

	it("全消去は、File Vault と Session Vault を消す", async () => {
		const controller = new FileVaultController(context())
		await saveOne(controller)
		const session = new PiiVault()
		session.assign("email", "bob@corp.example")
		mocks.showWarningMessage.mockResolvedValueOnce("common:pii.clearVault")

		await controller.clearAll(session)

		expect(session.size).toBe(0)
		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("{{email-005}}")
	})

	it("全消去を断れば、ファイルもセッションも消さない", async () => {
		const controller = new FileVaultController(context())
		await saveOne(controller)
		const session = new PiiVault()
		session.assign("email", "bob@corp.example")
		mocks.showWarningMessage.mockResolvedValueOnce(undefined)

		await controller.clearAll(session)

		expect(session.size).toBe(1)
		expect(await controller.restore(uri("/w/note.md"), "{{email-005}}", (text) => text)).toBe("alice@corp.example")
	})
})
