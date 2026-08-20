import { vi } from "vitest"

import type { ProviderCollaborators } from "../buildProviderCollaborators"
import { PendingEditOperationManager } from "../PendingEditOperationManager"
import { RecentTasksCache } from "../RecentTasksCache"

/**
 * `new ClineProvider(..., { collaborators })` に流し込む fake collaborator 一式。
 *
 * これがあると spec は ProviderSettingsManager / CustomModesManager / SkillsManager /
 * McpServerManager / WorkspaceTracker / TaskHistoryStore をモジュール単位でモックせずに
 * ClineProvider を構築できる（ディスク I/O・fs watcher・MCP 接続が実体化しない）。
 *
 * `pendingEditOperations` と `recentTasks` だけ実インスタンスなのは、どちらも vscode 非依存の
 * 純粋なメモリ構造で、fake にすると呼び出し側の挙動が検証できなくなるため。
 *
 * `src/core/task/__tests__/makeFakeCollaborators.ts`（Task 側）の ClineProvider 版。
 */
export function makeFakeProviderCollaborators(overrides: Partial<ProviderCollaborators> = {}): ProviderCollaborators {
	const base = {
		taskHistoryStore: {
			initialized: Promise.resolve(),
			get: vi.fn().mockReturnValue(undefined),
			getAll: vi.fn().mockReturnValue([]),
			upsert: vi.fn().mockResolvedValue([]),
			delete: vi.fn().mockResolvedValue(undefined),
			deleteMany: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		},
		historyWriteThrough: {
			schedule: vi.fn(),
			flush: vi.fn(),
		},
		recentTasks: new RecentTasksCache({ getHistory: () => [], getWorkspaceDir: () => "/test/workspace" }),
		taskHistoryReader: {
			getTaskWithId: vi.fn().mockRejectedValue(new Error("Task not found")),
			getTaskWithAggregatedCosts: vi.fn(),
		},
		taskStack: {
			size: 0,
			items: [],
			taskIds: vi.fn().mockReturnValue([]),
			getCurrent: vi.fn().mockReturnValue(undefined),
			getRoot: vi.fn().mockReturnValue(undefined),
			findByTaskId: vi.fn().mockReturnValue(undefined),
			setCleanup: vi.fn(),
			add: vi.fn().mockResolvedValue(undefined),
			removeTop: vi.fn().mockResolvedValue(undefined),
			replaceTop: vi.fn().mockResolvedValue(undefined),
			clearAll: vi.fn().mockResolvedValue(undefined),
		},
		taskDelegation: {
			delegateParentAndOpenChild: vi.fn().mockResolvedValue(undefined),
			reopenParentFromDelegation: vi.fn().mockResolvedValue(undefined),
		},
		taskDeletion: {
			deleteWithId: vi.fn().mockResolvedValue(undefined),
		},
		taskCancellation: {
			cancel: vi.fn().mockResolvedValue(undefined),
		},
		codeIndexStatus: {
			update: vi.fn(),
			reset: vi.fn(),
		},
		workspaceTracker: {
			initializeFilePaths: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		},
		webviewContent: {
			getHtmlContent: vi.fn().mockResolvedValue("<!DOCTYPE html><html></html>"),
			getHMRHtmlContent: vi.fn().mockResolvedValue("<!DOCTYPE html><html></html>"),
		},
		pendingEditOperations: new PendingEditOperationManager(() => {}),
		providerSettingsManager: {
			listConfig: vi.fn().mockResolvedValue([]),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			setModeConfig: vi.fn().mockResolvedValue(undefined),
			getProfile: vi.fn().mockResolvedValue({}),
			activateProfile: vi.fn().mockResolvedValue({ name: "default" }),
			saveConfig: vi.fn().mockResolvedValue("config-id"),
			resetAllConfigs: vi.fn().mockResolvedValue(undefined),
		},
		providerProfile: {
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getProviderProfileEntry: vi.fn().mockReturnValue(undefined),
			hasProviderProfileEntry: vi.fn().mockReturnValue(false),
			upsertProviderProfile: vi.fn().mockResolvedValue(undefined),
			deleteProviderProfile: vi.fn().mockResolvedValue(undefined),
			activateProviderProfile: vi.fn().mockResolvedValue(undefined),
			persistStickyProviderProfileToCurrentTask: vi.fn().mockResolvedValue(undefined),
			getProviderProfiles: vi.fn().mockResolvedValue([]),
			getProviderProfile: vi.fn().mockResolvedValue("default"),
			setProviderProfile: vi.fn().mockResolvedValue(undefined),
		},
		modeController: {
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		},
		historyProfileRestorer: {
			restore: vi.fn().mockResolvedValue(undefined),
		},
		customModesManager: {
			getCustomModes: vi.fn().mockResolvedValue([]),
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			resetCustomModes: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		},
		skillsManager: {
			initialize: vi.fn().mockResolvedValue(undefined),
			getSkills: vi.fn().mockReturnValue([]),
			dispose: vi.fn().mockResolvedValue(undefined),
		},
		taskCreationCallback: vi.fn(),
		// startBackgroundInitialization は省略する: 注入した collaborator では
		// TaskHistoryStore のマイグレーションも skill 探索も MCP 接続も走らせない。
	}

	return { ...base, ...overrides } as unknown as ProviderCollaborators
}
