// pnpm --filter openai-agent exec vitest run core/webview/__tests__/ClineProvider.collaborator-injection.spec.ts
import * as vscode from "vscode"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { HistoryItem } from "@openai-agent/types"

import { ClineProvider } from "../ClineProvider"
import type { ProviderCollaborators } from "../buildProviderCollaborators"
import { makeFakeProviderCollaborators } from "./makeFakeProviderCollaborators"

/**
 * `collaborators` 注入口の spec。
 *
 * ポイントは **この file が `vi.mock` を 1 つも書いていない**こと。collaborator を注入すると
 * ProviderSettingsManager / CustomModesManager / SkillsManager / McpServerManager /
 * WorkspaceTracker / TaskHistoryStore が一切構築されないので、それらを黙らせるための
 * モジュールモックが不要になる（Task 側 `Task.collaborator-injection.spec.ts` と同じ狙い）。
 */
describe("ClineProvider collaborator injection", () => {
	let collaborators: ProviderCollaborators
	let provider: ClineProvider
	let contextProxy: { setValue: ReturnType<typeof vi.fn>; getValue: ReturnType<typeof vi.fn> }

	const makeProvider = (injected: ProviderCollaborators) => {
		contextProxy = {
			setValue: vi.fn().mockResolvedValue(undefined),
			getValue: vi.fn().mockReturnValue(undefined),
			getValues: vi.fn().mockReturnValue({}),
			globalStorageUri: { fsPath: "/test/storage" },
			extensionUri: { fsPath: "/test/extension" },
		} as never

		const context = {
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			workspaceState: { get: vi.fn().mockReturnValue(false), update: vi.fn() },
			subscriptions: [],
			extension: { packageJSON: { version: "1.0.0" } },
			globalStorageUri: { fsPath: "/test/storage" },
			extensionUri: { fsPath: "/test/extension" },
		} as unknown as vscode.ExtensionContext

		const outputChannel = { appendLine: vi.fn(), dispose: vi.fn() } as unknown as vscode.OutputChannel

		return new ClineProvider(context, outputChannel, "sidebar", contextProxy as never, {
			collaborators: injected,
			taskFactory: () => ({ taskId: "injected-task" }) as never,
		})
	}

	beforeEach(() => {
		collaborators = makeFakeProviderCollaborators()
		provider = makeProvider(collaborators)
	})

	afterEach(async () => {
		await provider.dispose()
	})

	it("注入した collaborator をそのまま所有する（新規に new しない）", () => {
		expect(provider.taskHistoryStore).toBe(collaborators.taskHistoryStore)
		expect(provider.providerSettingsManager).toBe(collaborators.providerSettingsManager)
		expect(provider.webviewContent).toBe(collaborators.webviewContent)
		expect(provider.codeIndexStatus).toBe(collaborators.codeIndexStatus)
		expect(provider.pendingEditOperations).toBe(collaborators.pendingEditOperations)
		expect(provider.workspaceTracker).toBe(collaborators.workspaceTracker)
		expect(provider.getSkillsManager()).toBe(collaborators.skillsManager)
	})

	it("タスクスタック系の public API は taskStack へ委譲する", async () => {
		const task = { taskId: "t1" } as never

		await provider.addClineToStack(task)
		expect(collaborators.taskStack.add).toHaveBeenCalledWith(task)

		await provider.removeClineFromStack({ skipDelegationRepair: true })
		expect(collaborators.taskStack.removeTop).toHaveBeenCalledWith({ skipDelegationRepair: true })

		provider.getCurrentTaskStack()
		expect(collaborators.taskStack.taskIds).toHaveBeenCalled()

		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("キャンセル / 削除 / モード切替 / プロファイル操作を各 controller へ委譲する", async () => {
		await provider.cancelTask()
		expect(collaborators.taskCancellation.cancel).toHaveBeenCalled()

		await provider.deleteTaskWithId("task-9", false)
		expect(collaborators.taskDeletion.deleteWithId).toHaveBeenCalledWith("task-9", false)

		await provider.handleModeSwitch("architect")
		expect(collaborators.modeController.handleModeSwitch).toHaveBeenCalledWith("architect")

		await provider.setProviderProfile("my-profile")
		expect(collaborators.providerProfile.setProviderProfile).toHaveBeenCalledWith("my-profile")
	})

	it("履歴の read は taskHistoryReader へ委譲する", async () => {
		const historyItem = { id: "task-1" } as HistoryItem
		;(collaborators.taskHistoryReader.getTaskWithId as ReturnType<typeof vi.fn>).mockResolvedValue({ historyItem })

		await expect(provider.getTaskWithId("task-1")).resolves.toEqual({ historyItem })
	})

	it("getRecentTasks は recentTasks キャッシュへ委譲する", () => {
		const getSpy = vi.spyOn(collaborators.recentTasks, "get").mockReturnValue(["recent-1"])

		expect(provider.getRecentTasks()).toEqual(["recent-1"])
		expect(getSpy).toHaveBeenCalled()
	})

	it("履歴の更新は recentTasks を無効化する", async () => {
		const invalidateSpy = vi.spyOn(collaborators.recentTasks, "invalidate")

		await provider.updateTaskHistory({ id: "task-1", ts: 1, task: "t" } as HistoryItem, { broadcast: false })

		expect(collaborators.taskHistoryStore.upsert).toHaveBeenCalled()
		expect(invalidateSpy).toHaveBeenCalled()
	})

	it("dispose は所有する collaborator を残らず片付ける", async () => {
		await provider.dispose()

		expect(collaborators.taskStack.clearAll).toHaveBeenCalled()
		expect(collaborators.taskHistoryStore.dispose).toHaveBeenCalled()
		expect(collaborators.historyWriteThrough.flush).toHaveBeenCalled()
		expect(collaborators.workspaceTracker.dispose).toHaveBeenCalled()
		expect(collaborators.skillsManager.dispose).toHaveBeenCalled()
	})
})
