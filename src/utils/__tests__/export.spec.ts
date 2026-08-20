// npx vitest run utils/__tests__/export.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import * as path from "path"

vi.mock("vscode", () => ({
	Uri: {
		file: (p: string) => ({ fsPath: p, scheme: "file" }),
	},
	workspace: {
		workspaceFolders: undefined as unknown,
	},
}))

import * as vscode from "vscode"

import { resolveDefaultSaveUri, saveLastExportPath, type ExportContext } from "../export"

/** getValue/setValue を差し込める最小の ExportContext。 */
function makeContext(stored?: string): { ctx: ExportContext; setValue: ReturnType<typeof vi.fn> } {
	const setValue = vi.fn(async () => {})
	const ctx: ExportContext = {
		getValue: () => stored,
		setValue,
	}
	return { ctx, setValue }
}

const CONFIG_KEY = "lastExportPath"
const FILE_NAME = "export.json"

describe("resolveDefaultSaveUri", () => {
	beforeEach(() => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined
	})

	it("直近のエクスポートパスがあれば、そのディレクトリ + fileName を返す", () => {
		const prev = path.join(path.sep, "home", "user", "prev", "old.json")
		const { ctx } = makeContext(prev)

		const uri = resolveDefaultSaveUri(ctx, CONFIG_KEY, FILE_NAME)

		expect(uri.fsPath).toBe(path.join(path.dirname(prev), FILE_NAME))
	})

	it("直近パスが無ければ workspace フォルダ配下を既定にする", () => {
		const ws = path.join(path.sep, "test", "workspace")
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ws } }]
		const { ctx } = makeContext(undefined)

		const uri = resolveDefaultSaveUri(ctx, CONFIG_KEY, FILE_NAME)

		expect(uri.fsPath).toBe(path.join(ws, FILE_NAME))
	})

	it("useWorkspace:false なら workspace を無視して fallbackDir を使う", () => {
		const ws = path.join(path.sep, "test", "workspace")
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ws } }]
		const fallbackDir = path.join(path.sep, "downloads")
		const { ctx } = makeContext(undefined)

		const uri = resolveDefaultSaveUri(ctx, CONFIG_KEY, FILE_NAME, { useWorkspace: false, fallbackDir })

		expect(uri.fsPath).toBe(path.join(fallbackDir, FILE_NAME))
	})

	it("workspace フォルダが空配列なら fallbackDir にフォールバックする", () => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = []
		const fallbackDir = path.join(path.sep, "downloads")
		const { ctx } = makeContext(undefined)

		const uri = resolveDefaultSaveUri(ctx, CONFIG_KEY, FILE_NAME, { fallbackDir })

		expect(uri.fsPath).toBe(path.join(fallbackDir, FILE_NAME))
	})

	it("直近パスも workspace も fallback も無ければ fileName のみを返す", () => {
		const { ctx } = makeContext(undefined)

		const uri = resolveDefaultSaveUri(ctx, CONFIG_KEY, FILE_NAME)

		expect(uri.fsPath).toBe(FILE_NAME)
	})
})

describe("saveLastExportPath", () => {
	it("uri.fsPath を configKey へ保存する", async () => {
		const { ctx, setValue } = makeContext(undefined)
		const uri = vscode.Uri.file(path.join(path.sep, "saved", "here.json"))

		await saveLastExportPath(ctx, CONFIG_KEY, uri)

		expect(setValue).toHaveBeenCalledWith(CONFIG_KEY, uri.fsPath)
	})
})
