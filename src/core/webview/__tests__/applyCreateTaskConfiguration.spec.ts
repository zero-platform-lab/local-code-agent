import * as vscode from "vscode"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { AgentSettings, ModeConfig } from "@openai-agent/types"

import { applyCreateTaskConfiguration, type CreateTaskConfigurationHost } from "../applyCreateTaskConfiguration"

// 共有 vscode モックは ConfigurationTarget enum を持たないので、この spec だけ補う。
vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		workspace: {
			...(actual.workspace as Record<string, unknown>),
			getConfiguration: vi.fn(),
		},
	}
})

const GLOBAL_TARGET = 1

const makeHost = () => {
	const updateCustomMode = vi.fn().mockResolvedValue(undefined)
	const host: CreateTaskConfigurationHost = {
		setValues: vi.fn().mockResolvedValue(undefined),
		setProviderProfile: vi.fn().mockResolvedValue(undefined),
		customModesManager: { updateCustomMode },
	}
	return { host, updateCustomMode }
}

describe("applyCreateTaskConfiguration", () => {
	let update: ReturnType<typeof vi.fn>

	beforeEach(() => {
		update = vi.fn().mockResolvedValue(undefined)
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ update } as never)
	})

	it("設定を global state に書き込む", async () => {
		const { host } = makeHost()
		const configuration: AgentSettings = { mode: "architect" }

		await applyCreateTaskConfiguration(host, configuration)

		expect(host.setValues).toHaveBeenCalledWith(configuration)
	})

	it("コマンド許可/拒否とタイムアウトを VS Code 設定へ写す", async () => {
		const { host } = makeHost()

		await applyCreateTaskConfiguration(host, {
			allowedCommands: ["ls"],
			deniedCommands: ["rm"],
			commandExecutionTimeout: 30,
		})

		expect(update).toHaveBeenCalledWith("allowedCommands", ["ls"], GLOBAL_TARGET)
		expect(update).toHaveBeenCalledWith("deniedCommands", ["rm"], GLOBAL_TARGET)
		expect(update).toHaveBeenCalledWith("commandExecutionTimeout", 30, GLOBAL_TARGET)
	})

	it("未指定のキーはユーザー設定を触らない", async () => {
		const { host } = makeHost()

		await applyCreateTaskConfiguration(host, {})

		expect(update).not.toHaveBeenCalled()
	})

	it("commandExecutionTimeout が 0 でも書き込む（falsy だが有効値）", async () => {
		const { host } = makeHost()

		await applyCreateTaskConfiguration(host, { commandExecutionTimeout: 0 })

		expect(update).toHaveBeenCalledWith("commandExecutionTimeout", 0, GLOBAL_TARGET)
	})

	it("空配列でも書き込む（明示的な「許可なし」を尊重する）", async () => {
		const { host } = makeHost()

		await applyCreateTaskConfiguration(host, { allowedCommands: [] })

		expect(update).toHaveBeenCalledWith("allowedCommands", [], GLOBAL_TARGET)
	})

	it("currentApiConfigName があれば provider profile を切り替える", async () => {
		const { host } = makeHost()

		await applyCreateTaskConfiguration(host, { currentApiConfigName: "my-profile" })

		expect(host.setProviderProfile).toHaveBeenCalledWith("my-profile")
	})

	it("customModes は CustomModesManager にも登録する（マージ周期で消えないように）", async () => {
		const { host, updateCustomMode } = makeHost()
		const modes = [
			{ slug: "a", name: "A", roleDefinition: "", groups: [] },
			{ slug: "b", name: "B", roleDefinition: "", groups: [] },
		] as ModeConfig[]

		await applyCreateTaskConfiguration(host, { customModes: modes })

		expect(updateCustomMode).toHaveBeenCalledTimes(2)
		expect(updateCustomMode).toHaveBeenNthCalledWith(1, "a", modes[0])
		expect(updateCustomMode).toHaveBeenNthCalledWith(2, "b", modes[1])
	})

	it("customModes が空/未指定なら何も登録しない", async () => {
		const { host, updateCustomMode } = makeHost()

		await applyCreateTaskConfiguration(host, { customModes: [] })
		await applyCreateTaskConfiguration(host, {})

		expect(updateCustomMode).not.toHaveBeenCalled()
	})
})
