// npx vitest run core/config/__tests__/CustomModesManager.yamlParseNonError.spec.ts
//
// importModeWithRules の YAML パース失敗経路で、parseError が「Error でない値」のときに
// `parseError instanceof Error ? parseError.message : "Failed to parse YAML"` の非 Error 側を
// 実際に踏ませる専用ファイル。本体 spec は実物の yaml を使うため、ここだけ yaml.parse を
// 非 Error を throw するモックに差し替える（vi.mock はファイル単位なので分離する）。

import type { Mock } from "vitest"

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

vi.mock("yaml", () => ({
	// 文字列（非 Error）を throw する。
	parse: vi.fn(() => {
		throw "yaml-boom-str"
	}),
	stringify: vi.fn(() => ""),
}))

describe("CustomModesManager importModeWithRules (yaml.parse が非 Error を throw)", () => {
	it("非 Error のパース失敗では汎用メッセージ 'Failed to parse YAML' を返す", async () => {
		const mockContext = {
			globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []), setKeysForSync: vi.fn() },
			globalStorageUri: { fsPath: "/mock/settings" },
		} as unknown as vscode.ExtensionContext
		;(vscode.workspace.onDidSaveTextDocument as Mock).mockReturnValue({ dispose: vi.fn() })

		const manager = new CustomModesManager(mockContext, vi.fn())

		const result = await manager.importModeWithRules("anything", "global")

		expect(result.success).toBe(false)
		// 非 Error 側 = "Failed to parse YAML" が採用される。
		expect(result.error).toBe("Invalid YAML format: Failed to parse YAML")
	})
})
