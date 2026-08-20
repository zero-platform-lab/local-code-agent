// pnpm --filter openai-agent exec vitest run core/webview/__tests__/buildProviderCollaborators.spec.ts
import * as vscode from "vscode"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { GlobalState, HistoryItem } from "@openai-agent/types"

import {
	buildProviderCollaborators,
	type ProviderCollaboratorHost,
	type ProviderCollaboratorHostInternals,
} from "../buildProviderCollaborators"
import { CodeIndexStatusSubscriber } from "../CodeIndexStatusSubscriber"
import { GlobalStateHistoryWriteThrough } from "../GlobalStateHistoryWriteThrough"
import { HistoryProfileRestorer } from "../HistoryProfileRestorer"
import { ModeController } from "../ModeController"
import { PendingEditOperationManager } from "../PendingEditOperationManager"
import { ProviderProfileController } from "../ProviderProfileController"
import { RecentTasksCache } from "../RecentTasksCache"
import { TaskCancellationController } from "../TaskCancellationController"
import { TaskDelegationController } from "../TaskDelegationController"
import { TaskDeletionController } from "../TaskDeletionController"
import { TaskHistoryReader } from "../TaskHistoryReader"
import { TaskStackController } from "../TaskStackController"
import { WebviewContentGenerator } from "../WebviewContentGenerator"

const hoisted = vi.hoisted(() => ({
	storeInstances: [] as Array<{ storagePath: string; options: { onWrite: () => Promise<void> } }>,
	skillsInitialize: vi.fn().mockResolvedValue(undefined),
	getMcpInstance: vi.fn().mockResolvedValue({ registerClient: vi.fn() }),
	runStoreInit: vi.fn().mockResolvedValue(true),
}))

// 重い leaf だけモックする（配線が検証対象なので controller 群は実クラスのまま）。
vi.mock("../../task-persistence", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		TaskHistoryStore: class {
			getAll = vi.fn().mockReturnValue([])
			get = vi.fn()
			deleteMany = vi.fn()
			dispose = vi.fn()
			constructor(storagePath: string, options: { onWrite: () => Promise<void> }) {
				hoisted.storeInstances.push({ storagePath, options })
			}
		},
	}
})

vi.mock("../initializeTaskHistoryStore", () => ({
	runTaskHistoryStoreInitialization: hoisted.runStoreInit,
}))

vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: { getInstance: hoisted.getMcpInstance },
}))

vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: class {
		initialize = hoisted.skillsInitialize
	},
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: class {
		dispose = vi.fn()
	},
}))

vi.mock("../../config/ProviderSettingsManager", () => ({
	ProviderSettingsManager: class {
		getModeConfigId = vi.fn().mockResolvedValue(undefined)
		listConfig = vi.fn().mockResolvedValue([])
	},
}))

vi.mock("../../config/CustomModesManager", () => ({
	CustomModesManager: class {
		constructor(
			public context: unknown,
			public onUpdate: () => Promise<void>,
		) {}
		getCustomModes = vi.fn().mockResolvedValue([])
	},
}))

interface Harness {
	host: ProviderCollaboratorHost
	internals: ProviderCollaboratorHostInternals
	globalState: Partial<Record<keyof GlobalState, unknown>>
	emitted: Array<[string, unknown[]]>
}

const makeHarness = (overrides: Partial<ProviderCollaboratorHost> = {}): Harness => {
	const globalState: Partial<Record<keyof GlobalState, unknown>> = {}
	const emitted: Array<[string, unknown[]]> = []

	const host = {
		context: {
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			workspaceState: { get: vi.fn().mockReturnValue(false) },
		} as unknown as vscode.ExtensionContext,
		contextProxy: {
			globalStorageUri: { fsPath: "/test/storage" },
			extensionUri: { fsPath: "/test/extension" },
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn(),
			setValue: vi.fn().mockResolvedValue(undefined),
		} as never,
		cwd: "/test/workspace",
		view: undefined,
		webviewDisposables: [],
		providerSettingsManager: { getModeConfigId: vi.fn().mockResolvedValue(undefined) } as never,
		customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) } as never,
		taskHistoryStore: { getAll: vi.fn().mockReturnValue([]), get: vi.fn(), deleteMany: vi.fn() } as never,
		getState: vi.fn().mockResolvedValue({ mode: "code" }),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(undefined),
		getTaskWithId: vi.fn().mockResolvedValue({ historyItem: {} as HistoryItem }),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		deleteTaskFromState: vi.fn().mockResolvedValue(undefined),
		addClineToStack: vi.fn().mockResolvedValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn(),
		createTaskWithHistoryItem: vi.fn(),
		activateProviderProfile: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutClineMessages: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/settings"),
		emit: vi.fn((eventName: string, ...args: unknown[]) => {
			emitted.push([eventName, args])
			return true
		}),
		log: vi.fn(),
		...overrides,
	} as unknown as ProviderCollaboratorHost

	const internals: ProviderCollaboratorHostInternals = {
		getGlobalState: vi.fn((key: keyof GlobalState) => globalState[key]) as never,
		updateGlobalState: vi.fn(async (key: keyof GlobalState, value: unknown) => {
			globalState[key] = value
		}) as never,
	}

	return { host, internals, globalState, emitted }
}

describe("buildProviderCollaborators", () => {
	beforeEach(() => {
		hoisted.storeInstances.length = 0
		vi.clearAllMocks()
		hoisted.skillsInitialize.mockResolvedValue(undefined)
		hoisted.getMcpInstance.mockResolvedValue({ registerClient: vi.fn() })
		hoisted.runStoreInit.mockResolvedValue(true)
	})

	it("期待する collaborator を一式組み立てる", () => {
		const { host, internals } = makeHarness()

		const c = buildProviderCollaborators(host, internals)

		expect(c.historyWriteThrough).toBeInstanceOf(GlobalStateHistoryWriteThrough)
		expect(c.recentTasks).toBeInstanceOf(RecentTasksCache)
		expect(c.taskHistoryReader).toBeInstanceOf(TaskHistoryReader)
		expect(c.taskStack).toBeInstanceOf(TaskStackController)
		expect(c.taskDelegation).toBeInstanceOf(TaskDelegationController)
		expect(c.taskDeletion).toBeInstanceOf(TaskDeletionController)
		expect(c.taskCancellation).toBeInstanceOf(TaskCancellationController)
		expect(c.codeIndexStatus).toBeInstanceOf(CodeIndexStatusSubscriber)
		expect(c.webviewContent).toBeInstanceOf(WebviewContentGenerator)
		expect(c.pendingEditOperations).toBeInstanceOf(PendingEditOperationManager)
		expect(c.providerProfile).toBeInstanceOf(ProviderProfileController)
		expect(c.modeController).toBeInstanceOf(ModeController)
		expect(c.historyProfileRestorer).toBeInstanceOf(HistoryProfileRestorer)
		expect(typeof c.taskCreationCallback).toBe("function")
		expect(c.taskHistoryStore).toBeDefined()
		expect(c.workspaceTracker).toBeDefined()
		expect(c.skillsManager).toBeDefined()
		expect(c.customModesManager).toBeDefined()
		expect(c.providerSettingsManager).toBeDefined()
	})

	it("TaskHistoryStore を host の globalStorage パスで作り、初期化は起動時に走らせる", () => {
		const { host, internals } = makeHarness()

		const c = buildProviderCollaborators(host, internals)

		expect(hoisted.storeInstances).toHaveLength(1)
		expect(hoisted.storeInstances[0].storagePath).toBe("/test/storage")
		expect(hoisted.runStoreInit).not.toHaveBeenCalled()

		c.startBackgroundInitialization?.()

		expect(hoisted.runStoreInit).toHaveBeenCalledTimes(1)
	})

	it("store の onWrite が globalState への write-through をデバウンス予約する", async () => {
		vi.useFakeTimers()
		try {
			const { host, internals } = makeHarness()
			;(host.taskHistoryStore.getAll as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "a" } as HistoryItem])

			buildProviderCollaborators(host, internals)
			await hoisted.storeInstances[0].options.onWrite()

			expect(internals.updateGlobalState).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(5000)

			expect(internals.updateGlobalState).toHaveBeenCalledWith("taskHistory", [{ id: "a" }])
		} finally {
			vi.useRealTimers()
		}
	})

	it("build の時点では副作用のある起動処理を開始しない", () => {
		const { host, internals } = makeHarness()

		buildProviderCollaborators(host, internals)

		// SkillsManager.initialize() は同期プレフィックスで host.customModesManager を
		// 読むため、host が collaborator を代入し終える前に走らせてはいけない。
		expect(hoisted.skillsInitialize).not.toHaveBeenCalled()
		expect(hoisted.getMcpInstance).not.toHaveBeenCalled()
	})

	it("SkillsManager の初期化は startBackgroundInitialization で fire-and-forget、失敗しても throw しない", async () => {
		hoisted.skillsInitialize.mockRejectedValueOnce(new Error("skills boom"))
		const { host, internals } = makeHarness()
		const c = buildProviderCollaborators(host, internals)

		expect(() => c.startBackgroundInitialization?.()).not.toThrow()

		await Promise.resolve()
		await Promise.resolve()

		expect(hoisted.skillsInitialize).toHaveBeenCalled()
		expect(host.log).toHaveBeenCalledWith(expect.stringContaining("skills boom"))
	})

	it("startBackgroundInitialization は McpServerManager のシングルトンを返す", async () => {
		const hub = { registerClient: vi.fn() }
		hoisted.getMcpInstance.mockResolvedValue(hub)
		const { host, internals } = makeHarness()

		const c = buildProviderCollaborators(host, internals)

		await expect(c.startBackgroundInitialization?.()).resolves.toBe(hub)
		expect(hoisted.getMcpInstance).toHaveBeenCalledWith(host.context, host)
	})

	it("taskStack の deps は host の getState / log を見る", async () => {
		const { host, internals } = makeHarness()
		const c = buildProviderCollaborators(host, internals)

		await c.taskStack.add({ taskId: "t1", instanceId: "i1", emit: vi.fn(), abortTask: vi.fn() } as never)

		expect(host.getState).toHaveBeenCalled()
		expect(c.taskStack.taskIds()).toEqual(["t1"])
	})

	it("codeIndexStatus の deps は host の manager / webviewDisposables を見る", () => {
		const disposable = { dispose: vi.fn() }
		const manager = {
			onProgressUpdate: vi.fn().mockReturnValue(disposable),
			getCurrentStatus: vi.fn().mockReturnValue({ systemStatus: "Indexed" }),
		}
		const { host, internals } = makeHarness({
			view: {} as never,
			getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(manager) as never,
		})

		const c = buildProviderCollaborators(host, internals)
		c.codeIndexStatus.update()

		expect(host.webviewDisposables).toContain(disposable)
		expect(host.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: { systemStatus: "Indexed" },
		})
	})

	it("providerSettingsManager は host 経由の遅延参照なので構築後の差し替えに追従する", async () => {
		const { host, internals } = makeHarness()
		const c = buildProviderCollaborators(host, internals)

		// spec が構築後に差し替えるケース（`provider.providerSettingsManager = fake`）
		const replacement = {
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			listConfig: vi.fn().mockResolvedValue([]),
		}
		;(host as { providerSettingsManager: unknown }).providerSettingsManager = replacement

		await c.modeController.handleModeSwitch("architect")

		expect(replacement.getModeConfigId).toHaveBeenCalledWith("architect")
		expect(internals.updateGlobalState).toHaveBeenCalledWith("mode", "architect")
	})

	it("customModesManager も host 経由の遅延参照（履歴からのモード復元）", async () => {
		const { host, internals } = makeHarness()
		const c = buildProviderCollaborators(host, internals)

		const replacement = { getCustomModes: vi.fn().mockResolvedValue([]) }
		;(host as { customModesManager: unknown }).customModesManager = replacement

		await c.historyProfileRestorer.restore({ id: "t", mode: "architect" } as HistoryItem, true)

		expect(replacement.getCustomModes).toHaveBeenCalled()
	})

	it("providerProfile の emit は host の typed emit を通る", async () => {
		const { host, internals, emitted } = makeHarness()
		const c = buildProviderCollaborators(host, internals)
		;(host as { providerSettingsManager: unknown }).providerSettingsManager = {
			activateProfile: vi.fn().mockResolvedValue({ name: "p1", id: "id1", apiProvider: "openai" }),
			listConfig: vi.fn().mockResolvedValue([]),
			setModeConfig: vi.fn().mockResolvedValue(undefined),
		}
		;(host.contextProxy as unknown as { setProviderSettings: unknown }).setProviderSettings = vi
			.fn()
			.mockResolvedValue(undefined)

		await c.providerProfile.activateProviderProfile({ name: "p1" })

		expect(emitted.map(([name]) => name)).toContain("providerProfileChanged")
	})
})
