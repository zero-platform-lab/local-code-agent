// npx vitest run core/webview/__tests__/buildExtensionState.spec.ts
//
// webview へ送る ExtensionState を組み立てる純関数。既定値の適用がここに
// 集約されているため、「未設定なら既定へ落ち、設定済みならそのまま通す」の
// 両側を検証する。

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
	},
	env: { language: "en" },
}))

import {
	DEFAULT_AUTONOMY_MODE,
	DEFAULT_ENABLE_CHECKPOINTS,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	DEFAULT_MAX_WORKSPACE_FILES,
	DEFAULT_SHOW_AGENT_IGNORED_FILES,
	DEFAULT_WRITE_DELAY_MS,
} from "@openai-agent/types"

import { buildExtensionState, type ExtensionStateExtras } from "../buildExtensionState"
import { defaultModeSlug } from "../../../shared/modes"
import { experimentDefault } from "../../../shared/experiments"

const extras: ExtensionStateExtras = {
	version: "0.0.0-test",
	cwd: "/repo",
	currentTaskId: undefined,
	currentTaskItem: undefined,
	clineMessages: [],
	currentTaskTodos: [],
	messageQueue: [],
	taskHistory: [],
	mergedAllowedCommands: ["git status"],
	mergedDeniedCommands: ["rm -rf"],
	mcpServers: [],
	renderContext: "sidebar",
	settingsImportedAt: undefined,
	hasOpenedModeSelector: false,
}

describe("buildExtensionState", () => {
	it("未設定のフィールドは既定値へ落とす", () => {
		const result = buildExtensionState({ apiConfiguration: {} } as never, extras)

		expect(result.mode).toBe(defaultModeSlug)
		expect(result.autonomyMode).toBe(DEFAULT_AUTONOMY_MODE)
		expect(result.autoApprovalEnabled).toBe(false)
		expect(result.alwaysAllowReadOnly).toBe(false)
		expect(result.alwaysAllowWrite).toBe(false)
		expect(result.alwaysAllowExecute).toBe(false)
		expect(result.enableCheckpoints).toBe(DEFAULT_ENABLE_CHECKPOINTS)
		expect(result.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
		expect(result.maxOpenTabsContext).toBe(DEFAULT_MAX_OPEN_TABS_CONTEXT)
		expect(result.maxWorkspaceFiles).toBe(DEFAULT_MAX_WORKSPACE_FILES)
		expect(result.showAgentIgnoredFiles).toBe(DEFAULT_SHOW_AGENT_IGNORED_FILES)
		expect(result.customModePrompts).toEqual({})
		expect(result.customSupportPrompts).toEqual({})
		expect(result.experiments).toEqual(experimentDefault)
		expect(result.listApiConfigMeta).toEqual([])
		expect(result.pinnedApiConfigs).toEqual({})
	})

	it("設定済みのフィールドはそのまま通す", () => {
		const result = buildExtensionState(
			{
				apiConfiguration: { apiProvider: "openai" },
				mode: "research",
				autonomyMode: "plan",
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				enableCheckpoints: false,
				writeDelayMs: 123,
				maxOpenTabsContext: 5,
				maxWorkspaceFiles: 10,
				showAgentIgnoredFiles: true,
				customModePrompts: { research: { roleDefinition: "r" } },
				customSupportPrompts: { ENHANCE: "e" },
				listApiConfigMeta: [{ id: "1", name: "cfg" }],
				pinnedApiConfigs: { "1": true },
			} as never,
			extras,
		)

		expect(result.mode).toBe("research")
		expect(result.autonomyMode).toBe("plan")
		expect(result.autoApprovalEnabled).toBe(true)
		expect(result.alwaysAllowReadOnly).toBe(true)
		expect(result.alwaysAllowWrite).toBe(true)
		expect(result.alwaysAllowExecute).toBe(true)
		expect(result.enableCheckpoints).toBe(false)
		expect(result.writeDelayMs).toBe(123)
		expect(result.maxOpenTabsContext).toBe(5)
		expect(result.maxWorkspaceFiles).toBe(10)
		expect(result.customModePrompts).toEqual({ research: { roleDefinition: "r" } })
		expect(result.listApiConfigMeta).toEqual([{ id: "1", name: "cfg" }])
		expect(result.pinnedApiConfigs).toEqual({ "1": true })
	})

	it("extras 由来のフィールドはそのまま載せる", () => {
		const result = buildExtensionState({ apiConfiguration: {} } as never, extras)

		expect(result.version).toBe("0.0.0-test")
		expect(result.cwd).toBe("/repo")
		expect(result.allowedCommands).toEqual(["git status"])
		expect(result.deniedCommands).toEqual(["rm -rf"])
		expect(result.renderContext).toBe("sidebar")
		expect(result.hasOpenedModeSelector).toBe(false)
	})
})
