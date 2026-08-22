// npx vitest run src/context/__tests__/ExtensionStateContext.messages.spec.tsx

import { render, act } from "@/utils/test-utils"

import type { HistoryItem } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"

import {
	ExtensionStateContextProvider,
	useExtensionState,
	type ExtensionStateContextType,
} from "../ExtensionStateContext"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/utils/textMateToHljs", () => ({
	convertTextMateToHljs: (theme: unknown) => ({ converted: theme }),
}))

let context: ExtensionStateContextType

const Capture = () => {
	context = useExtensionState()
	return null
}

const renderProvider = () =>
	render(
		<ExtensionStateContextProvider>
			<Capture />
		</ExtensionStateContextProvider>,
	)

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

/** 関数以外（= 状態）だけを取り出す。関数は毎描画で作り直されるため比較対象にならない。 */
const snapshot = () => Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value !== "function"))

const historyItem = (id: string, ts: number): HistoryItem => ({
	id,
	number: 1,
	ts,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

describe("ExtensionStateContextProvider messages", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("announces itself to the extension once", () => {
		renderProvider()

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "webviewDidLaunch" })
		expect(context.didHydrateState).toBe(false)
	})

	it("stops listening once unmounted", () => {
		const { unmount } = renderProvider()
		unmount()

		post({ type: "state", state: { version: "9.9.9" } })

		expect(context.version).not.toBe("9.9.9")
	})

	describe("state", () => {
		it("hydrates from the extension", () => {
			renderProvider()

			post({ type: "state", state: { version: "1.2.3", mode: "architect" } })

			expect(context.didHydrateState).toBe(true)
			expect(context.version).toBe("1.2.3")
			expect(context.mode).toBe("architect")
		})

		it("tolerates a state message without a payload", () => {
			renderProvider()

			post({ type: "state" })

			expect(context.didHydrateState).toBe(true)
		})

		it("adopts the auto-approve and enhance flags when they are present", () => {
			renderProvider()

			post({
				type: "state",
				state: {
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 4321,
					includeTaskHistoryInEnhance: false,
					includeCurrentTime: false,
					includeCurrentCost: false,
				},
			})

			expect(context.alwaysAllowFollowupQuestions).toBe(true)
			expect(context.followupAutoApproveTimeoutMs).toBe(4321)
			expect(context.includeTaskHistoryInEnhance).toBe(false)
			expect(context.includeCurrentTime).toBe(false)
			expect(context.includeCurrentCost).toBe(false)
		})

		it("keeps the current flags when the state message omits them", () => {
			renderProvider()

			post({
				type: "state",
				state: {
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 4321,
					includeTaskHistoryInEnhance: false,
					includeCurrentTime: false,
					includeCurrentCost: false,
				},
			})
			post({ type: "state", state: { version: "2.0.0" } })

			expect(context.alwaysAllowFollowupQuestions).toBe(true)
			expect(context.followupAutoApproveTimeoutMs).toBe(4321)
			expect(context.includeTaskHistoryInEnhance).toBe(false)
			expect(context.includeCurrentTime).toBe(false)
			expect(context.includeCurrentCost).toBe(false)
		})
	})

	describe("action", () => {
		it("toggles auto approval and reports it back", () => {
			renderProvider()

			post({ type: "action", action: "toggleAutoApprove" })

			expect(context.autoApprovalEnabled).toBe(true)
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: true })

			post({ type: "action", action: "toggleAutoApprove" })

			expect(context.autoApprovalEnabled).toBe(false)
			expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "autoApprovalEnabled", bool: false })
		})

		it("ignores other actions", () => {
			renderProvider()

			post({ type: "action", action: "settingsButtonClicked" })

			expect(context.autoApprovalEnabled).toBe(false)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "autoApprovalEnabled" }),
			)
		})
	})

	describe("theme", () => {
		it("converts the theme it is handed", () => {
			renderProvider()

			post({ type: "theme", text: JSON.stringify({ name: "dark" }) })

			expect(context.theme).toEqual({ converted: { name: "dark" } })
		})

		it("ignores an empty theme message", () => {
			renderProvider()

			post({ type: "theme" })

			expect(context.theme).toBeUndefined()
		})
	})

	describe("workspace", () => {
		it("records the file paths and opened tabs", () => {
			renderProvider()

			post({
				type: "workspaceUpdated",
				filePaths: ["a.ts"],
				openedTabs: [{ label: "a.ts", isActive: true, path: "/a.ts" }],
			})

			expect(context.filePaths).toEqual(["a.ts"])
			expect(context.openedTabs).toEqual([{ label: "a.ts", isActive: true, path: "/a.ts" }])
		})

		it("clears them when the message carries nothing", () => {
			renderProvider()

			post({ type: "workspaceUpdated", filePaths: ["a.ts"], openedTabs: [{ label: "a.ts", isActive: true }] })
			post({ type: "workspaceUpdated" })

			expect(context.filePaths).toEqual([])
			expect(context.openedTabs).toEqual([])
		})
	})

	describe("commands", () => {
		it("stores the commands and clears them when omitted", () => {
			renderProvider()

			post({ type: "commands", commands: [{ name: "init", source: "project", filePath: "/init.md" }] })
			expect(context.commands).toHaveLength(1)

			post({ type: "commands" })
			expect(context.commands).toEqual([])
		})
	})

	describe("messageUpdated", () => {
		it("replaces the message with the same timestamp", () => {
			renderProvider()
			post({
				type: "state",
				state: {
					clineMessages: [
						{ ts: 1, type: "say", say: "text", text: "one" },
						{ ts: 2, type: "say", say: "text", text: "two" },
					],
				},
			})

			post({ type: "messageUpdated", clineMessage: { ts: 2, type: "say", say: "text", text: "two updated" } })

			expect(context.clineMessages.map((message) => message.text)).toEqual(["one", "two updated"])
		})

		it("drops updates for unknown timestamps", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			renderProvider()
			post({ type: "state", state: { clineMessages: [{ ts: 1, type: "say", say: "text", text: "one" }] } })

			post({ type: "messageUpdated", clineMessage: { ts: 99, type: "say", say: "text", text: "ghost" } })

			expect(context.clineMessages.map((message) => message.text)).toEqual(["one"])
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("ts=99"))
			warn.mockRestore()
		})
	})

	describe("skills", () => {
		it("stores the skills and ignores an empty message", () => {
			renderProvider()

			post({ type: "skills", skills: [{ name: "review", description: "d", source: "project", path: "/s" }] })
			expect(context.skills).toHaveLength(1)

			post({ type: "skills" })
			expect(context.skills).toHaveLength(1)
		})
	})

	describe("mcpServers", () => {
		it("stores the servers and clears them when omitted", () => {
			renderProvider()

			post({ type: "mcpServers", mcpServers: [{ name: "srv", config: "{}", status: "connected" }] })
			expect(context.mcpServers).toHaveLength(1)

			post({ type: "mcpServers" })
			expect(context.mcpServers).toEqual([])
		})
	})

	it("tracks the current checkpoint", () => {
		renderProvider()

		post({ type: "currentCheckpointUpdated", text: "abc123" })
		expect(context.currentCheckpoint).toBe("abc123")

		post({ type: "currentCheckpointUpdated" })
		expect(context.currentCheckpoint).toBeUndefined()
	})

	it("tracks the api configuration list", () => {
		renderProvider()

		post({ type: "listApiConfig", listApiConfig: [{ id: "1", name: "default", apiProvider: "openai" }] })
		expect(context.listApiConfigMeta).toHaveLength(1)

		post({ type: "listApiConfig" })
		expect(context.listApiConfigMeta).toEqual([])
	})

	describe("taskHistoryUpdated", () => {
		it("replaces the whole history", () => {
			renderProvider()

			post({ type: "taskHistoryUpdated", taskHistory: [historyItem("a", 1)] })
			expect(context.taskHistory.map((item) => item.id)).toEqual(["a"])

			post({ type: "taskHistoryUpdated", taskHistory: [] })
			expect(context.taskHistory).toEqual([])
		})

		it("ignores a message without a history", () => {
			renderProvider()

			post({ type: "taskHistoryUpdated", taskHistory: [historyItem("a", 1)] })
			post({ type: "taskHistoryUpdated" })

			expect(context.taskHistory.map((item) => item.id)).toEqual(["a"])
		})
	})

	describe("taskHistoryItemUpdated", () => {
		it("inserts an unknown item and keeps the list newest-first", () => {
			renderProvider()
			post({ type: "taskHistoryUpdated", taskHistory: [historyItem("b", 20)] })

			// 先頭に足されるが、古い項目なので並べ替えで後ろへ下がる。
			post({ type: "taskHistoryItemUpdated", taskHistoryItem: historyItem("a", 10) })

			expect(context.taskHistory.map((item) => item.id)).toEqual(["b", "a"])
		})

		it("replaces an item it already knows and re-sorts it", () => {
			renderProvider()
			post({ type: "taskHistoryUpdated", taskHistory: [historyItem("b", 20), historyItem("a", 10)] })

			post({ type: "taskHistoryItemUpdated", taskHistoryItem: { ...historyItem("a", 30), task: "renamed" } })

			expect(context.taskHistory.map((item) => item.id)).toEqual(["a", "b"])
			expect(context.taskHistory[0].task).toBe("renamed")
		})

		it("keeps the current task in sync only when it is the one that changed", () => {
			renderProvider()
			post({
				type: "state",
				state: { taskHistory: [historyItem("a", 10)], currentTaskItem: historyItem("a", 10) },
			})

			post({ type: "taskHistoryItemUpdated", taskHistoryItem: { ...historyItem("a", 10), task: "renamed" } })
			expect(context.currentTaskItem?.task).toBe("renamed")

			post({ type: "taskHistoryItemUpdated", taskHistoryItem: historyItem("b", 20) })
			expect(context.currentTaskItem?.id).toBe("a")
			expect(context.currentTaskItem?.task).toBe("renamed")
		})

		it("ignores a message without an item", () => {
			renderProvider()
			post({ type: "taskHistoryUpdated", taskHistory: [historyItem("a", 10)] })

			post({ type: "taskHistoryItemUpdated" })

			expect(context.taskHistory.map((item) => item.id)).toEqual(["a"])
		})
	})

	// 拡張ホストからの state は JSON で運ばれるため、未設定の設定値が null で届くことがある。
	describe("null が届いたとき", () => {
		const nullState = {
			type: "state",
			state: {
				reasoningBlockCollapsed: null,
				enterBehavior: null,
				profileThresholds: null,
				pinnedApiConfigs: null,
				autoApprovalEnabled: null,
			},
		}

		it("falls back to the defaults", () => {
			renderProvider()

			post(nullState)

			expect(context.reasoningBlockCollapsed).toBe(true)
			expect(context.enterBehavior).toBe("send")
			expect(context.profileThresholds).toEqual({})
		})

		it("still toggles auto approval on", () => {
			renderProvider()
			post(nullState)

			post({ type: "action", action: "toggleAutoApprove" })

			expect(context.autoApprovalEnabled).toBe(true)
		})

		it("still pins configurations", () => {
			renderProvider()
			post(nullState)

			act(() => context.togglePinnedApiConfig("cfg"))

			expect(context.pinnedApiConfigs).toEqual({ cfg: true })
		})
	})

	it("ignores message types it does not know", () => {
		renderProvider()
		const before = snapshot()

		post({ type: "somethingCompletelyDifferent" })

		expect(snapshot()).toEqual(before)
	})
})

describe("ExtensionStateContextProvider setters", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const cases: Array<[string, string, unknown]> = [
		["setCustomInstructions", "customInstructions", "be brief"],
		["setAlwaysAllowReadOnly", "alwaysAllowReadOnly", true],
		["setAlwaysAllowReadOnlyOutsideWorkspace", "alwaysAllowReadOnlyOutsideWorkspace", true],
		["setAlwaysAllowWrite", "alwaysAllowWrite", true],
		["setAlwaysAllowWriteOutsideWorkspace", "alwaysAllowWriteOutsideWorkspace", true],
		["setAlwaysAllowExecute", "alwaysAllowExecute", true],
		["setAlwaysAllowMcp", "alwaysAllowMcp", true],
		["setAlwaysAllowSubtasks", "alwaysAllowSubtasks", true],
		["setAlwaysAllowFollowupQuestions", "alwaysAllowFollowupQuestions", true],
		["setFollowupAutoApproveTimeoutMs", "followupAutoApproveTimeoutMs", 1234],
		["setAllowedCommands", "allowedCommands", ["ls"]],
		["setDeniedCommands", "deniedCommands", ["rm -rf"]],
		["setAllowedMaxRequests", "allowedMaxRequests", 7],
		["setAllowedMaxCost", "allowedMaxCost", 3],
		["setEnableCheckpoints", "enableCheckpoints", false],
		["setCheckpointTimeout", "checkpointTimeout", 42],
		["setWriteDelayMs", "writeDelayMs", 99],
		["setTerminalOutputPreviewSize", "terminalOutputPreviewSize", "large"],
		["setTerminalShellIntegrationTimeout", "terminalShellIntegrationTimeout", 4000],
		["setTerminalShellIntegrationDisabled", "terminalShellIntegrationDisabled", true],
		["setTerminalZdotdir", "terminalZdotdir", true],
		["setMcpEnabled", "mcpEnabled", false],
		["setCurrentApiConfigName", "currentApiConfigName", "profile"],
		["setListApiConfigMeta", "listApiConfigMeta", [{ id: "1", name: "default", apiProvider: "openai" }]],
		["setMode", "mode", "architect"],
		["setCustomModePrompts", "customModePrompts", { code: { roleDefinition: "r" } }],
		["setCustomSupportPrompts", "customSupportPrompts", { ENHANCE: "e" }],
		["setEnhancementApiConfigId", "enhancementApiConfigId", "cfg"],
		["setAutoApprovalEnabled", "autoApprovalEnabled", true],
		["setCustomModes", "customModes", [{ slug: "x", name: "X", roleDefinition: "r", groups: [] }]],
		["setMaxOpenTabsContext", "maxOpenTabsContext", 25],
		["setMaxWorkspaceFiles", "maxWorkspaceFiles", 123],
		["setShowAgentIgnoredFiles", "showAgentIgnoredFiles", false],
		["setEnableSubfolderRules", "enableSubfolderRules", true],
		["setAwsUsePromptCache", "awsUsePromptCache", true],
		["setMaxImageFileSize", "maxImageFileSize", 11],
		["setMaxTotalImageSize", "maxTotalImageSize", 22],
		["setPinnedApiConfigs", "pinnedApiConfigs", { a: true }],
		["setHistoryPreviewCollapsed", "historyPreviewCollapsed", true],
		["setReasoningBlockCollapsed", "reasoningBlockCollapsed", false],
		["setEnterBehavior", "enterBehavior", "newline"],
		["setHasOpenedModeSelector", "hasOpenedModeSelector", true],
		["setAutoCondenseContext", "autoCondenseContext", false],
		["setAutoCondenseContextPercent", "autoCondenseContextPercent", 42],
		["setProfileThresholds", "profileThresholds", { p: 50 }],
		["setIncludeDiagnosticMessages", "includeDiagnosticMessages", false],
		["setMaxDiagnosticMessages", "maxDiagnosticMessages", 5],
		["setIncludeTaskHistoryInEnhance", "includeTaskHistoryInEnhance", false],
		["setIncludeCurrentTime", "includeCurrentTime", false],
		["setIncludeCurrentCost", "includeCurrentCost", false],
		["setShowWorktreesInHomeScreen", "showWorktreesInHomeScreen", false],
	]

	it.each(cases)("%s writes only %s", (setter, field, value) => {
		renderProvider()
		const before = snapshot()

		act(() => {
			;(context as any)[setter](value)
		})

		expect(snapshot()).toEqual({ ...before, [field]: value })
	})

	it("setExperimentEnabled writes a single experiment flag", () => {
		renderProvider()
		const before = snapshot()

		act(() => {
			context.setExperimentEnabled("powerSteering" as any, true)
		})

		expect(snapshot()).toEqual({
			...before,
			experiments: { ...(before.experiments as object), powerSteering: true },
		})
	})

	it("setApiConfiguration merges into the existing configuration", () => {
		renderProvider()

		act(() => context.setApiConfiguration({ apiProvider: "openai" }))
		act(() => context.setApiConfiguration({ apiModelId: "gpt-5" }))

		expect(context.apiConfiguration).toMatchObject({ apiProvider: "openai", apiModelId: "gpt-5" })
	})

	it("togglePinnedApiConfig pins and then unpins", () => {
		renderProvider()

		act(() => context.togglePinnedApiConfig("cfg"))
		expect(context.pinnedApiConfigs).toEqual({ cfg: true })

		act(() => context.togglePinnedApiConfig("cfg"))
		expect(context.pinnedApiConfigs).toEqual({})
	})

	it("togglePinnedApiConfig keeps the other pins", () => {
		renderProvider()

		act(() => context.setPinnedApiConfigs({ other: true }))
		act(() => context.togglePinnedApiConfig("cfg"))

		expect(context.pinnedApiConfigs).toEqual({ other: true, cfg: true })
	})
})
