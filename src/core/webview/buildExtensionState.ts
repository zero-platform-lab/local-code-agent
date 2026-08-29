import * as vscode from "vscode"

import {
	type ExtensionState,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_AUTONOMY_MODE,
	DEFAULT_MAX_DIAGNOSTIC_MESSAGES,
	DEFAULT_MAX_GIT_STATUS_FILES,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	DEFAULT_MAX_WORKSPACE_FILES,
	DEFAULT_ENABLE_CHECKPOINTS,
	DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS,
	DEFAULT_SHOW_AGENT_IGNORED_FILES,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
} from "@openai-agent/types"

import { experimentDefault } from "../../shared/experiments"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { defaultModeSlug } from "../../shared/modes"
import { formatLanguage } from "../../shared/language"
import { Package } from "../../shared/package"

/** ClineProvider.getState() が返す状態（webview 送信用に一部フィールドを除いたもの）。 */
type StateForWebview = Omit<ExtensionState, "clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version">

/**
 * getState() 由来でない、ClineProvider 側で解決して渡す追加値。
 * Task/McpHub の具象型ではなく ExtensionState のフィールド型で受けることで循環依存を避ける。
 */
export interface ExtensionStateExtras {
	version: ExtensionState["version"]
	cwd: ExtensionState["cwd"]
	currentTaskId: ExtensionState["currentTaskId"]
	currentTaskItem: ExtensionState["currentTaskItem"]
	clineMessages: ExtensionState["clineMessages"]
	currentTaskTodos: ExtensionState["currentTaskTodos"]
	messageQueue: ExtensionState["messageQueue"]
	taskHistory: ExtensionState["taskHistory"]
	mergedAllowedCommands: string[]
	mergedDeniedCommands: string[]
	mcpServers: ExtensionState["mcpServers"]
	renderContext: ExtensionState["renderContext"]
	settingsImportedAt: ExtensionState["settingsImportedAt"]
	hasOpenedModeSelector: ExtensionState["hasOpenedModeSelector"]
}

/**
 * getState() の結果と ClineProvider 側で解決した extras から、webview に送る
 * ExtensionState を組み立てる純関数。既定値の適用ロジックはここに集約する。
 */
export function buildExtensionState(state: StateForWebview, extras: ExtensionStateExtras): ExtensionState {
	const {
		apiConfiguration,
		customInstructions,
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowSubtasks,
		allowedMaxRequests,
		allowedMaxCost,
		autoCondenseContext,
		autoCondenseContextPercent,
		enableCheckpoints,
		checkpointTimeout,
		writeDelayMs,
		terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled,
		terminalCommandDelay,
		terminalZdotdir,
		mcpEnabled,
		currentApiConfigName,
		listApiConfigMeta,
		pinnedApiConfigs,
		mode,
		customModePrompts,
		customSupportPrompts,
		enhancementApiConfigId,
		autonomyMode,
		autoApprovalEnabled,
		experiments,
		maxOpenTabsContext,
		maxWorkspaceFiles,
		disabledTools,
		showAgentIgnoredFiles,
		enableSubfolderRules,
		language,
		maxImageFileSize,
		maxTotalImageSize,
		historyPreviewCollapsed,
		reasoningBlockCollapsed,
		enterBehavior,
		organizationAllowList,
		customCondensingPrompt,
		codebaseIndexConfig,
		codebaseIndexModels,
		profileThresholds,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		includeCurrentTime,
		includeCurrentCost,
		maxGitStatusFiles,
		lockApiConfigAcrossModes,
	} = state

	return {
		version: extras.version,
		apiConfiguration,
		customInstructions,
		alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
		alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
		alwaysAllowWrite: alwaysAllowWrite ?? false,
		alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
		alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
		alwaysAllowExecute: alwaysAllowExecute ?? false,
		alwaysAllowMcp: alwaysAllowMcp ?? false,
		alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
		allowedMaxRequests,
		allowedMaxCost,
		autoCondenseContext: autoCondenseContext ?? true,
		autoCondenseContextPercent: autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
		uriScheme: vscode.env.uriScheme,
		currentTaskId: extras.currentTaskId,
		currentTaskItem: extras.currentTaskItem,
		clineMessages: extras.clineMessages,
		currentTaskTodos: extras.currentTaskTodos,
		messageQueue: extras.messageQueue,
		taskHistory: extras.taskHistory,
		enableCheckpoints: enableCheckpoints ?? DEFAULT_ENABLE_CHECKPOINTS,
		checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		allowedCommands: extras.mergedAllowedCommands,
		deniedCommands: extras.mergedDeniedCommands,
		writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
		terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS,
		terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
		terminalCommandDelay: terminalCommandDelay ?? 0,
		terminalZdotdir: terminalZdotdir ?? false,
		mcpEnabled: mcpEnabled ?? true,
		currentApiConfigName: currentApiConfigName ?? "default",
		listApiConfigMeta: listApiConfigMeta ?? [],
		pinnedApiConfigs: pinnedApiConfigs ?? {},
		mode: mode ?? defaultModeSlug,
		customModePrompts: customModePrompts ?? {},
		customSupportPrompts: customSupportPrompts ?? {},
		enhancementApiConfigId,
		autonomyMode: autonomyMode ?? DEFAULT_AUTONOMY_MODE,
		autoApprovalEnabled: autoApprovalEnabled ?? false,
		experiments: experiments ?? experimentDefault,
		mcpServers: extras.mcpServers,
		maxOpenTabsContext: maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT,
		maxWorkspaceFiles: maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES,
		cwd: extras.cwd,
		disabledTools,
		showAgentIgnoredFiles: showAgentIgnoredFiles ?? DEFAULT_SHOW_AGENT_IGNORED_FILES,
		enableSubfolderRules: enableSubfolderRules ?? false,
		language: language ?? formatLanguage(vscode.env.language),
		renderContext: extras.renderContext,
		maxImageFileSize: maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
		maxTotalImageSize: maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
		settingsImportedAt: extras.settingsImportedAt,
		historyPreviewCollapsed: historyPreviewCollapsed ?? false,
		reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
		enterBehavior: enterBehavior ?? "send",
		organizationAllowList,
		customCondensingPrompt,
		codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
		codebaseIndexConfig: {
			codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
			codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai-compatible",
			codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
			codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
			codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
			codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
			codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
			codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
		},
		profileThresholds: profileThresholds ?? {},
		hasOpenedModeSelector: extras.hasOpenedModeSelector,
		lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
		alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
		followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
		includeDiagnosticMessages: includeDiagnosticMessages ?? true,
		maxDiagnosticMessages: maxDiagnosticMessages ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGES,
		includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
		includeCurrentTime: includeCurrentTime ?? true,
		includeCurrentCost: includeCurrentCost ?? true,
		maxGitStatusFiles: maxGitStatusFiles ?? DEFAULT_MAX_GIT_STATUS_FILES,
		debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
	}
}
