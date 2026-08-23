// npx vitest run core/config/__tests__/CustomModesManager.loadError.spec.ts
//
// hasLoadError() の検証。読み込みに失敗すると customModes は [] に落ちるが、これは
// 「カスタムモードが 1 件も無い」状態と区別が付かない。保存済み mode slug の解決側が
// この 2 つを取り違えると、制限付きモードが既定モード（全権限）へ黙って昇格する。

import type { Mock } from "vitest"

import * as fs from "fs/promises"
import * as vscode from "vscode"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn(),
		createFileSystemWatcher: vi.fn(),
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")

const makeManager = () => {
	const mockContext = {
		globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []), setKeysForSync: vi.fn() },
		globalStorageUri: { fsPath: "/mock/settings" },
	} as unknown as vscode.ExtensionContext
	;(vscode.workspace.onDidSaveTextDocument as Mock).mockReturnValue({ dispose: vi.fn() })

	return new CustomModesManager(mockContext, vi.fn())
}

describe("CustomModesManager.hasLoadError", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("正常に読めたら false", async () => {
		;(fs.readFile as Mock).mockResolvedValue(
			"customModes:\n  - slug: my-mode\n    name: My Mode\n    roleDefinition: You do my work\n    groups: [read]\n",
		)

		const manager = makeManager()
		const modes = await manager.getCustomModes()

		expect(modes).toHaveLength(1)
		expect(manager.hasLoadError()).toBe(false)
	})

	it("カスタムモードが 0 件でも、読めていれば false", async () => {
		// 「空」と「失敗」を取り違えないこと。既定状態がここに当たる。
		;(fs.readFile as Mock).mockResolvedValue("customModes: []\n")

		const manager = makeManager()

		expect(await manager.getCustomModes()).toEqual([])
		expect(manager.hasLoadError()).toBe(false)
	})

	it("YAML が壊れていたら true", async () => {
		;(fs.readFile as Mock).mockResolvedValue("customModes:\n  - slug: [unclosed\n")

		const manager = makeManager()

		expect(await manager.getCustomModes()).toEqual([])
		expect(manager.hasLoadError()).toBe(true)
	})

	it("スキーマ違反でも true", async () => {
		// slug はあるが name / roleDefinition / groups が無い
		;(fs.readFile as Mock).mockResolvedValue("customModes:\n  - slug: broken\n")

		const manager = makeManager()

		expect(await manager.getCustomModes()).toEqual([])
		expect(manager.hasLoadError()).toBe(true)
	})

	it("読み込み自体が失敗しても true", async () => {
		;(fs.readFile as Mock).mockRejectedValue(new Error("EIO"))

		const manager = makeManager()

		expect(await manager.getCustomModes()).toEqual([])
		expect(manager.hasLoadError()).toBe(true)
	})
})
