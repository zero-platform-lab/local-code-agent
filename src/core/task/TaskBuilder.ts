import { DEFAULT_CONSECUTIVE_MISTAKE_LIMIT, type ProviderSettings } from "@openai-agent/types"

import { ApiHandler, buildApiHandler } from "../../api"
import { DiffStrategy } from "../../shared/tools"

import { AutoApprovalHandler } from "../auto-approval"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AgentProtectedController } from "../protect/AgentProtectedController"
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"

import { MistakeTracker } from "./MistakeTracker"
import { TaskMessageStore } from "./TaskMessageStore"
import type { TaskProviderRef } from "./taskProviderRef"

/**
 * Task constructor が `new` していた「Task 自身への参照が不要な」 collaborator 群。
 *
 * `DiffViewProvider` / `TokenUsageTracker` / `ApiRequestTimingController` は Task
 * インスタンスを host として要求するため、Task constructor 内で構築するのが自然
 * （2-phase init 回避）。それら以外の collaborator は Task の外で組み立て可能で、
 * テストが fake を注入できるようにするための factory。
 */
export interface TaskCollaborators {
	apiConfiguration: ProviderSettings
	api: ApiHandler
	autoApprovalHandler: AutoApprovalHandler
	rooIgnoreController: AgentIgnoreController
	rooProtectedController: AgentProtectedController
	fileContextTracker: FileContextTracker
	messageStore: TaskMessageStore
	messageQueueService: MessageQueueService
	diffStrategy: DiffStrategy
	toolRepetitionDetector: ToolRepetitionDetector
	mistakeTracker: MistakeTracker
}

export interface BuildTaskCollaboratorsInput {
	apiConfiguration: ProviderSettings
	provider: TaskProviderRef
	taskId: string
	cwd: string
	globalStoragePath: string
	consecutiveMistakeLimit?: number
}

/**
 * Task 構築時に必要な collaborator を組み立てる。
 *
 * `rooIgnoreController.initialize()` は fire-and-forget（既存動作を保持）。呼び出し側
 * （Task constructor / test factory）は返り値 collaborators をそのまま使う。
 */
export function buildTaskCollaborators(input: BuildTaskCollaboratorsInput): TaskCollaborators {
	const rooIgnoreController = new AgentIgnoreController(input.cwd)
	rooIgnoreController.initialize().catch((error) => {
		console.error("Failed to initialize AgentIgnoreController:", error)
	})

	const mistakeTracker = new MistakeTracker(input.consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT)

	return {
		apiConfiguration: input.apiConfiguration,
		api: buildApiHandler(input.apiConfiguration),
		autoApprovalHandler: new AutoApprovalHandler(),
		rooIgnoreController,
		rooProtectedController: new AgentProtectedController(input.cwd),
		fileContextTracker: new FileContextTracker(input.provider, input.taskId),
		messageStore: new TaskMessageStore(input.taskId, input.globalStoragePath),
		messageQueueService: new MessageQueueService(),
		diffStrategy: new MultiSearchReplaceDiffStrategy(),
		toolRepetitionDetector: new ToolRepetitionDetector(mistakeTracker.limit),
		mistakeTracker,
	}
}
