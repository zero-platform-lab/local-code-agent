import * as vscode from "vscode"

import {
	type ExtensionState,
	type AgentSettings,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	DEFAULT_MAX_WORKSPACE_FILES,
	DEFAULT_MAX_GIT_STATUS_FILES,
	DEFAULT_MAX_DIAGNOSTIC_MESSAGES,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	DEFAULT_AUTONOMY_MODE,
	DEFAULT_ENABLE_CHECKPOINTS,
	DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS,
	DEFAULT_SHOW_AGENT_IGNORED_FILES,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
} from "@openai-agent/types"

import { experimentDefault } from "../../shared/experiments"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { type Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { formatLanguage } from "../../shared/language"

/** getState() の戻り型（webview 送信用に一部フィールドを除いた ExtensionState）。 */
type StateForWebview = Omit<ExtensionState, "clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version">

/**
 * contextProxy.getValues() 由来でない、ClineProvider 側で解決して渡す追加値。
 * 具象型（McpHub 等）ではなく戻り型のフィールド型で受けることで循環依存を避ける。
 */
export interface StateExtras {
	apiConfiguration: StateForWebview["apiConfiguration"]
	taskHistory: StateForWebview["taskHistory"]
	mcpServers: StateForWebview["mcpServers"]
	organizationAllowList: StateForWebview["organizationAllowList"]
	lockApiConfigAcrossModes: StateForWebview["lockApiConfigAcrossModes"]
}

/**
 * contextProxy の設定値（AgentSettings）と ClineProvider 側で解決した extras から、
 * getState() が返す状態オブジェクトを組み立てる純関数。既定値の適用はここに集約する。
 */
export function buildState(stateValues: AgentSettings, extras: StateExtras): StateForWebview {
	return {
		apiConfiguration: extras.apiConfiguration,
		customInstructions: stateValues.customInstructions,
		apiModelId: stateValues.apiModelId,
		alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
		alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
		alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
		alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
		alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
		alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
		alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
		alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
		alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
		followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
		diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
		allowedMaxRequests: stateValues.allowedMaxRequests,
		allowedMaxCost: stateValues.allowedMaxCost,
		autoCondenseContext: stateValues.autoCondenseContext ?? true,
		autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
		taskHistory: extras.taskHistory,
		allowedCommands: stateValues.allowedCommands,
		deniedCommands: stateValues.deniedCommands,
		enableCheckpoints: stateValues.enableCheckpoints ?? DEFAULT_ENABLE_CHECKPOINTS,
		checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
		terminalShellIntegrationTimeout:
			stateValues.terminalShellIntegrationTimeout ?? DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS,
		terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
		terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
		terminalZdotdir: stateValues.terminalZdotdir ?? false,
		// 保存済みの mode が解決できないときは既定へ落とす。`??` は null/undefined しか
		// 拾わないため、削除された組み込みモード（architect など）の slug が残っていると
		// そのまま通ってしまう。その状態では isToolAllowedForMode の `if (!mode) return false`
		// に落ちて、常時ツール以外がすべて拒否される。
		mode: resolveMode(stateValues.mode),
		language: stateValues.language ?? formatLanguage(vscode.env.language),
		mcpEnabled: stateValues.mcpEnabled ?? true,
		mcpServers: extras.mcpServers,
		currentApiConfigName: stateValues.currentApiConfigName ?? "default",
		listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
		pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
		modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
		customModePrompts: stateValues.customModePrompts ?? {},
		customSupportPrompts: stateValues.customSupportPrompts ?? {},
		enhancementApiConfigId: stateValues.enhancementApiConfigId,
		experiments: stateValues.experiments ?? experimentDefault,
		autonomyMode: stateValues.autonomyMode ?? DEFAULT_AUTONOMY_MODE,
		autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
		maxOpenTabsContext: stateValues.maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT,
		maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES,
		disabledTools: stateValues.disabledTools,
		showAgentIgnoredFiles: stateValues.showAgentIgnoredFiles ?? DEFAULT_SHOW_AGENT_IGNORED_FILES,
		enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
		maxImageFileSize: stateValues.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
		maxTotalImageSize: stateValues.maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
		historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
		reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
		enterBehavior: stateValues.enterBehavior ?? "send",
		organizationAllowList: extras.organizationAllowList,
		customCondensingPrompt: stateValues.customCondensingPrompt,
		codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
		codebaseIndexConfig: {
			codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
			codebaseIndexQdrantUrl: stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai-compatible",
			codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
			codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
			codebaseIndexEmbedderModelDimension: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
			codebaseIndexOpenAiCompatibleBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
			codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
			codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
		},
		profileThresholds: stateValues.profileThresholds ?? {},
		lockApiConfigAcrossModes: extras.lockApiConfigAcrossModes,
		includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
		maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGES,
		includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
		includeCurrentTime: stateValues.includeCurrentTime ?? true,
		includeCurrentCost: stateValues.includeCurrentCost ?? true,
		maxGitStatusFiles: stateValues.maxGitStatusFiles ?? DEFAULT_MAX_GIT_STATUS_FILES,
	}
}

/**
 * 保存された mode slug を、実在するモードへ解決する。
 *
 * 解決できない slug を素通しすると `isToolAllowedForMode` の `if (!mode) return false`
 * に落ち、常時ツール以外がすべて拒否される。削除済みの組み込みモードや、撤去済みの
 * カスタムモード機構で作られた slug が globalState に残っている場合がこれにあたるので、
 * 既定へ落とす。
 */
function resolveMode(saved: string | undefined): Mode {
	if (!saved) {
		return defaultModeSlug
	}

	if (getModeBySlug(saved)) {
		return saved as Mode
	}

	return defaultModeSlug
}
