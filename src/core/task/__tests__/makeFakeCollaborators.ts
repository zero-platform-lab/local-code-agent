import { vi } from "vitest"

import type { ProviderSettings } from "@openai-agent/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { MistakeTracker } from "../MistakeTracker"
import type { TaskCollaborators } from "../TaskBuilder"
import { TaskMessageStore } from "../TaskMessageStore"

/**
 * `new Task({ collaborators })` に流し込む fake collaborator 一式。
 *
 * これがあると test は `vi.mock("../../ignore/AgentIgnoreController")` のような
 * モジュール単位のモックを書かずに済む（fs watcher / API handler / ディスク I/O が
 * 実体化しない）。`mistakeTracker` と `messageQueueService` だけ実インスタンスにして
 * あるのは、前者が field mutation を、後者が constructor の `on("stateChanged")`
 * 登録を必要とするため。
 */
export interface MakeFakeCollaboratorsOptions extends Partial<TaskCollaborators> {
	/** TaskMessageStore は vscode 非依存なので実インスタンスをデフォルトにする（fake だと
	 * `vi.mock("../../task-persistence", ...)` 経由の spy が届かないため）。上書きしたい
	 * ときは overrides で messageStore を渡す。 */
	messageStoreTaskId?: string
	messageStoreGlobalStoragePath?: string
}

export function makeFakeCollaborators(overrides: MakeFakeCollaboratorsOptions = {}): TaskCollaborators {
	const {
		messageStoreTaskId = "test-task-id",
		messageStoreGlobalStoragePath = "/test/storage",
		...collaboratorOverrides
	} = overrides
	const mistakeTracker = new MistakeTracker(3)

	const base = {
		apiConfiguration: {} as ProviderSettings,
		api: {
			createMessage: vi.fn(),
			getModel: vi.fn().mockReturnValue({ id: "fake-model", info: { contextWindow: 128_000 } }),
			countTokens: vi.fn().mockResolvedValue(0),
		},
		autoApprovalHandler: {
			checkAutoApprovalLimits: vi.fn().mockResolvedValue({ shouldProceed: true }),
		},
		rooIgnoreController: {
			initialize: vi.fn().mockResolvedValue(undefined),
			validateAccess: vi.fn().mockReturnValue(true),
			validateCommand: vi.fn().mockReturnValue(null),
			dispose: vi.fn(),
		},
		rooProtectedController: {
			isWriteProtected: vi.fn().mockReturnValue(false),
		},
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
			getAndClearRecentlyModifiedFiles: vi.fn().mockReturnValue([]),
			dispose: vi.fn(),
		},
		// vscode 非依存かつ内部で呼ぶ `saveApiMessages` などは module mock が届く実装
		// を使う（fake の spy だと persistence 系 spec の retry/error 経路が検証不能）
		messageStore: new TaskMessageStore(messageStoreTaskId, messageStoreGlobalStoragePath),
		messageQueueService: new MessageQueueService(),
		diffStrategy: {
			getName: vi.fn().mockReturnValue("fake-diff-strategy"),
			getToolDescription: vi.fn().mockReturnValue(""),
			applyDiff: vi.fn().mockResolvedValue({ success: true, content: "" }),
		},
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
		},
		mistakeTracker,
	}

	return { ...base, ...collaboratorOverrides } as unknown as TaskCollaborators
}
