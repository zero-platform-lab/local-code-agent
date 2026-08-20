import * as fs from "fs/promises"

import { describe, it, expect, vi, beforeEach } from "vitest"

import {
	ensureServersSection,
	readServerEntries,
	readSettingsFile,
	requireServersSection,
	resolveSettingsPath,
	serverOrderFrom,
	type McpSettingsFile,
} from "../mcpSettingsFile"

vi.mock("fs/promises", () => ({
	access: vi.fn(),
	readFile: vi.fn(),
}))

const mockAccess = vi.mocked(fs.access)
const mockReadFile = vi.mocked(fs.readFile)

describe("resolveSettingsPath", () => {
	const paths = {
		getGlobalSettingsPath: vi.fn().mockResolvedValue("/global/mcp_settings.json"),
		getProjectSettingsPath: vi.fn().mockResolvedValue("/project/.agent/mcp.json"),
	}

	beforeEach(() => {
		vi.clearAllMocks()
		paths.getGlobalSettingsPath.mockResolvedValue("/global/mcp_settings.json")
		paths.getProjectSettingsPath.mockResolvedValue("/project/.agent/mcp.json")
	})

	it("global はグローバル設定パスを返す", async () => {
		await expect(resolveSettingsPath(paths, "global")).resolves.toBe("/global/mcp_settings.json")
		expect(paths.getProjectSettingsPath).not.toHaveBeenCalled()
	})

	it("project はプロジェクト設定パスを返す", async () => {
		await expect(resolveSettingsPath(paths, "project")).resolves.toBe("/project/.agent/mcp.json")
	})

	it("プロジェクト設定が無ければ throw する", async () => {
		paths.getProjectSettingsPath.mockResolvedValue(null)

		await expect(resolveSettingsPath(paths, "project")).rejects.toThrow("Project MCP configuration file not found")
	})
})

describe("readSettingsFile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockAccess.mockResolvedValue(undefined)
	})

	it("読み込んで JSON を返す", async () => {
		mockReadFile.mockResolvedValue('{"mcpServers":{"a":{}}}' as never)

		await expect(readSettingsFile("/settings.json")).resolves.toEqual({ mcpServers: { a: {} } })
	})

	it("アクセスできなければ throw する", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"))

		await expect(readSettingsFile("/settings.json")).rejects.toThrow("Settings file not accessible")
		expect(mockReadFile).not.toHaveBeenCalled()
	})

	it("JSON がオブジェクトでなければ throw する", async () => {
		mockReadFile.mockResolvedValue("42" as never)

		await expect(readSettingsFile("/settings.json")).rejects.toThrow("Invalid config structure")
	})

	it("null も無効な構造として扱う", async () => {
		mockReadFile.mockResolvedValue("null" as never)

		await expect(readSettingsFile("/settings.json")).rejects.toThrow("Invalid config structure")
	})

	it("壊れた JSON は SyntaxError がそのまま伝播する", async () => {
		mockReadFile.mockResolvedValue("{not json" as never)

		await expect(readSettingsFile("/settings.json")).rejects.toThrow(SyntaxError)
	})
})

describe("requireServersSection", () => {
	it("mcpServers を返す", () => {
		const config: McpSettingsFile = { mcpServers: { a: {} } }

		expect(requireServersSection(config)).toBe(config.mcpServers)
	})

	it("mcpServers が無ければ throw する", () => {
		expect(() => requireServersSection({})).toThrow("No mcpServers section in config")
		expect(() => requireServersSection({ mcpServers: "nope" as never })).toThrow("No mcpServers section in config")
	})
})

describe("ensureServersSection", () => {
	it("既存の mcpServers をそのまま返す", () => {
		const config: McpSettingsFile = { mcpServers: { a: {} } }

		expect(ensureServersSection(config)).toBe(config.mcpServers)
	})

	it("無ければ空セクションを作って設定に差し込む", () => {
		const config: McpSettingsFile = {}
		const servers = ensureServersSection(config)

		expect(servers).toEqual({})
		// 返り値への書き込みが設定オブジェクトに反映されること
		servers.a = { command: "node" }
		expect(config.mcpServers).toEqual({ a: { command: "node" } })
	})

	it("mcpServers 以外のキーは保つ", () => {
		const config: McpSettingsFile = { someOtherKey: 1 }

		ensureServersSection(config)

		expect(config.someOtherKey).toBe(1)
	})
})

describe("readServerEntries", () => {
	const paths = {
		getGlobalSettingsPath: vi.fn(),
		getProjectSettingsPath: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
		paths.getGlobalSettingsPath.mockResolvedValue("/global.json")
		paths.getProjectSettingsPath.mockResolvedValue("/project.json")
	})

	it("mcpServers セクションを返す", async () => {
		mockReadFile.mockResolvedValue('{"mcpServers":{"a":{"alwaysAllow":["t"]}}}' as never)

		await expect(readServerEntries(paths, "global")).resolves.toEqual({ a: { alwaysAllow: ["t"] } })
	})

	it("セクションが無ければ空オブジェクト", async () => {
		mockReadFile.mockResolvedValue("{}" as never)

		await expect(readServerEntries(paths, "global")).resolves.toEqual({})
	})

	it("project 設定ファイルが無ければ null（呼び出し側が扱いを決める）", async () => {
		paths.getProjectSettingsPath.mockResolvedValue(null)

		await expect(readServerEntries(paths, "project")).resolves.toBeNull()
		expect(mockReadFile).not.toHaveBeenCalled()
	})

	it("存在チェックをしない（readSettingsFile と違い access を呼ばない）", async () => {
		mockReadFile.mockResolvedValue("{}" as never)

		await readServerEntries(paths, "global")

		expect(mockAccess).not.toHaveBeenCalled()
	})

	it("読み取り失敗は握り潰さず伝播させる", async () => {
		mockReadFile.mockRejectedValue(new Error("EACCES"))

		await expect(readServerEntries(paths, "global")).rejects.toThrow("EACCES")
	})

	it("壊れた JSON も伝播させる", async () => {
		mockReadFile.mockResolvedValue("{oops" as never)

		await expect(readServerEntries(paths, "global")).rejects.toThrow(SyntaxError)
	})
})

describe("serverOrderFrom", () => {
	it("設定ファイルの記述順を保つ", () => {
		expect(serverOrderFrom({ b: {}, a: {}, c: {} })).toEqual(["b", "a", "c"])
	})

	it("null / 空でも空配列", () => {
		expect(serverOrderFrom(null)).toEqual([])
		expect(serverOrderFrom({})).toEqual([])
	})
})
