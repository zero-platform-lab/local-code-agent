import { describe, it, expect, vi } from "vitest"
import * as vscode from "vscode"

import {
	missingFieldsErrorMessage,
	mixedFieldsErrorMessage,
	parseMcpSettings,
	ServerConfigSchema,
	sseFieldsErrorMessage,
	stdioFieldsErrorMessage,
	streamableHttpFieldsErrorMessage,
	typeErrorMessage,
	urlWithoutTypeErrorMessage,
	validateServerConfig,
} from "../serverConfigSchema"

describe("validateServerConfig", () => {
	it("command だけで stdio と推論する", () => {
		const config = validateServerConfig({ command: "node" })

		expect(config.type).toBe("stdio")
		expect(config).toMatchObject({ command: "node", timeout: 60, alwaysAllow: [], disabledTools: [] })
	})

	it("url + type で sse / streamable-http を受け付ける", () => {
		expect(validateServerConfig({ type: "sse", url: "https://example.test" }).type).toBe("sse")
		expect(validateServerConfig({ type: "streamable-http", url: "https://example.test" }).type).toBe(
			"streamable-http",
		)
	})

	it("stdio と url 系のフィールドを混ぜたら弾く", () => {
		expect(() => validateServerConfig({ command: "node", url: "https://example.test" })).toThrow(
			mixedFieldsErrorMessage,
		)
	})

	it("url があるのに type が無ければ弾く（sse か streamable-http か決められない）", () => {
		expect(() => validateServerConfig({ url: "https://example.test" })).toThrow(urlWithoutTypeErrorMessage)
	})

	it("未知の type を弾く", () => {
		expect(() => validateServerConfig({ type: "carrier-pigeon", command: "node" })).toThrow(typeErrorMessage)
	})

	it("type と実フィールドの不一致を弾く", () => {
		expect(() => validateServerConfig({ type: "stdio", foo: 1 })).toThrow(stdioFieldsErrorMessage)
		expect(() => validateServerConfig({ type: "sse" })).toThrow(sseFieldsErrorMessage)
		expect(() => validateServerConfig({ type: "streamable-http" })).toThrow(streamableHttpFieldsErrorMessage)
	})

	it("command も url も無ければ弾く", () => {
		expect(() => validateServerConfig({ timeout: 30 })).toThrow(missingFieldsErrorMessage)
	})

	it("schema 違反はサーバ名つきのメッセージにする", () => {
		expect(() => validateServerConfig({ command: "node", timeout: 99999 }, "my-server")).toThrow(
			/Invalid configuration for server "my-server":/,
		)
	})

	it("サーバ名が無ければ汎用メッセージにする", () => {
		expect(() => validateServerConfig({ command: "node", timeout: 99999 })).toThrow(
			/^Invalid server configuration:/,
		)
	})

	it("空の command は schema 側で弾く（フィールド自体は存在するため）", () => {
		expect(() => validateServerConfig({ command: "" })).toThrow(/^Invalid server configuration:/)
	})

	it("cwd 未指定なら workspace の先頭フォルダを既定にする", () => {
		const original = vscode.workspace.workspaceFolders
		// cwd default（() => workspaceFolders?.at(0)?.uri.fsPath ?? cwd()）の「フォルダ有り」側を通す。
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws-root" } }]
		try {
			const config = validateServerConfig({ command: "node" })
			expect((config as { cwd?: string }).cwd).toBe("/ws-root")
		} finally {
			;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = original
		}
	})

	it("ZodError 以外の parse 失敗はラップせずそのまま伝播する", () => {
		// pre-validation を通過（command 有り）させたうえで parse だけを非 Zod 例外にする。
		const nonZod = new Error("non-zod failure")
		const spy = vi.spyOn(ServerConfigSchema, "parse").mockImplementation(() => {
			throw nonZod
		})
		try {
			expect(() => validateServerConfig({ command: "node" })).toThrow(nonZod)
		} finally {
			spy.mockRestore()
		}
	})
})

describe("parseMcpSettings", () => {
	it("正しい設定なら servers を返す", () => {
		const result = parseMcpSettings({ mcpServers: { a: { command: "node" } } })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(Object.keys(result.servers)).toEqual(["a"])
			expect(result.servers.a.type).toBe("stdio")
		}
	})

	it("mcpServers が空でも成功する", () => {
		const result = parseMcpSettings({ mcpServers: {} })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.servers).toEqual({})
		}
	})

	it("mcpServers セクションが無ければ失敗する", () => {
		const result = parseMcpSettings({})

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errorMessages).toContain("mcpServers")
		}
	})

	it("失敗時は zod のエラーを改行区切りで整形する", () => {
		const result = parseMcpSettings({ mcpServers: { a: { command: "node", timeout: 99999 } } })

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errorMessages).toMatch(/mcpServers\.a/)
		}
	})

	it("throw せず結果で返す（呼び出し側が続行可否を決めるため）", () => {
		expect(() => parseMcpSettings(null)).not.toThrow()
		expect(parseMcpSettings(null).ok).toBe(false)
	})
})
