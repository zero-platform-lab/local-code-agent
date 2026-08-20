import { type GlobalState, type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"
import { CodeIndexManager } from "../../services/code-index/manager"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * コードインデックス関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。実処理は
 * CodeIndexManager（ワークスペース単位）が持ち、ここは設定の保存と
 * manager のライフサイクル操作、状態の webview への通知を担う。
 *
 * ワークスペースが開かれていない場合 `getCurrentWorkspaceCodeIndexManager()` は
 * undefined を返す。その場合も webview には必ずエラー状態を返す（返さないと
 * webview 側が応答待ちのまま固まるため）。
 */
type CodeIndexMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** ワークスペース未オープン時に webview へ返すインデックス状態。 */
const noWorkspaceStatus = () => ({
	systemStatus: "Error" as const,
	message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
	processedItems: 0,
	totalItems: 0,
	currentItemUnit: "items",
})

export const codeIndexMessageHandlers: Partial<Record<WebviewMessage["type"], CodeIndexMessageHandler>> = {
	saveCodeIndexSettingsAtomic: async (provider, message) => {
		const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)
		const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
			await provider.contextProxy.setValue(key, value)

		if (!message.codeIndexSettings) {
			return
		}

		const settings = message.codeIndexSettings

		try {
			// Check if embedder provider has changed
			const currentConfig = getGlobalState("codebaseIndexConfig") || {}
			const embedderProviderChanged =
				currentConfig.codebaseIndexEmbedderProvider !== settings.codebaseIndexEmbedderProvider

			// Save global state settings atomically
			const globalStateConfig = {
				...currentConfig,
				codebaseIndexEnabled: settings.codebaseIndexEnabled,
				codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
				codebaseIndexEmbedderProvider: "openai-compatible" as const,
				codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
				codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
				codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension, // Generic dimension
				codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
			}

			// Save global state first
			await updateGlobalState("codebaseIndexConfig", globalStateConfig)

			// Save secrets directly using context proxy
			if (settings.codeIndexQdrantApiKey !== undefined) {
				await provider.contextProxy.storeSecret("codeIndexQdrantApiKey", settings.codeIndexQdrantApiKey)
			}
			if (settings.codebaseIndexOpenAiCompatibleApiKey !== undefined) {
				await provider.contextProxy.storeSecret(
					"codebaseIndexOpenAiCompatibleApiKey",
					settings.codebaseIndexOpenAiCompatibleApiKey,
				)
			}

			// Send success response first - settings are saved regardless of validation
			await provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: true,
				settings: globalStateConfig,
			})

			// Update webview state
			await provider.postStateToWebview()

			// Then handle validation and initialization for the current workspace
			const currentCodeIndexManager = provider.getCurrentWorkspaceCodeIndexManager()
			if (currentCodeIndexManager) {
				// If embedder provider changed, perform proactive validation
				if (embedderProviderChanged) {
					try {
						// Force handleSettingsChange which will trigger validation
						await currentCodeIndexManager.handleSettingsChange()
					} catch (error) {
						// Validation failed - the error state is already set by handleSettingsChange
						provider.log(`Embedder validation failed after provider change: ${toErrorMessage(error)}`)
						// Send validation error to webview
						await provider.postMessageToWebview({
							type: "indexingStatusUpdate",
							values: currentCodeIndexManager.getCurrentStatus(),
						})
						// Exit early - don't try to start indexing with invalid configuration
						return
					}
				} else {
					// No provider change, just handle settings normally
					try {
						await currentCodeIndexManager.handleSettingsChange()
					} catch (error) {
						// Log but don't fail - settings are saved
						provider.log(`Settings change handling error: ${toErrorMessage(error)}`)
					}
				}

				// Wait a bit more to ensure everything is ready
				await new Promise((resolve) => setTimeout(resolve, 200))

				// Auto-start indexing if now enabled and configured
				if (currentCodeIndexManager.isFeatureEnabled && currentCodeIndexManager.isFeatureConfigured) {
					if (!currentCodeIndexManager.isInitialized) {
						try {
							await currentCodeIndexManager.initialize(provider.contextProxy)
							provider.log(`Code index manager initialized after settings save`)
						} catch (error) {
							provider.log(`Code index initialization failed: ${toErrorMessage(error)}`)
							// Send error status to webview
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: currentCodeIndexManager.getCurrentStatus(),
							})
						}
					}
				}
			} else {
				// No workspace open - send error status
				provider.log("Cannot save code index settings: No workspace folder open")
				await provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: noWorkspaceStatus(),
				})
			}
		} catch (error) {
			// 元の実装に合わせ、Error でない値が投げられた場合も message プロパティを拾う。
			const message = (error as { message?: string } | undefined)?.message
			provider.log(`Error saving code index settings: ${message || error}`)
			await provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: false,
				error: message || "Failed to save settings",
			})
		}
	},

	requestIndexingStatus: async (provider) => {
		const manager = provider.getCurrentWorkspaceCodeIndexManager()
		if (!manager) {
			// No workspace open - send error status
			provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: { ...noWorkspaceStatus(), workerspacePath: undefined },
			})
			return
		}

		provider.postMessageToWebview({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus(),
		})
	},

	requestCodeIndexSecretStatus: async (provider) => {
		// Check if secrets are set using the VSCode context directly for async access
		const hasQdrantApiKey = !!(await provider.context.secrets.get("codeIndexQdrantApiKey"))
		const hasOpenAiCompatibleApiKey = !!(await provider.context.secrets.get("codebaseIndexOpenAiCompatibleApiKey"))

		provider.postMessageToWebview({
			type: "codeIndexSecretStatus",
			values: {
				hasQdrantApiKey,
				hasOpenAiCompatibleApiKey,
			},
		})
	},

	startIndexing: async (provider) => {
		try {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: noWorkspaceStatus(),
				})
				provider.log("Cannot start indexing: No workspace folder open")
				return
			}

			// "Start Indexing" implicitly enables the workspace
			await manager.setWorkspaceEnabled(true)

			if (manager.isFeatureEnabled && manager.isFeatureConfigured) {
				await manager.initialize(provider.contextProxy)

				const currentState = manager.state
				if (currentState === "Standby" || currentState === "Error") {
					manager.startIndexing()

					if (!manager.isInitialized) {
						await manager.initialize(provider.contextProxy)
						if (manager.state === "Standby" || manager.state === "Error") {
							manager.startIndexing()
						}
					}
				}
			}
		} catch (error) {
			provider.log(`Error starting indexing: ${toErrorMessage(error)}`)
		}
	},

	stopIndexing: async (provider) => {
		try {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				provider.log("Cannot stop indexing: No workspace folder open")
				return
			}
			manager.stopIndexing()
			provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: manager.getCurrentStatus(),
			})
		} catch (error) {
			provider.log(`Error stopping indexing: ${toErrorMessage(error)}`)
		}
	},

	toggleWorkspaceIndexing: async (provider, message) => {
		try {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				provider.log("Cannot toggle workspace indexing: No workspace folder open")
				return
			}
			const enabled = message.bool ?? false
			await manager.setWorkspaceEnabled(enabled)
			if (enabled && manager.isFeatureEnabled && manager.isFeatureConfigured) {
				await manager.initialize(provider.contextProxy)
				manager.startIndexing()
			} else if (!enabled) {
				manager.stopIndexing()
			}
			provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: manager.getCurrentStatus(),
			})
		} catch (error) {
			provider.log(`Error toggling workspace indexing: ${toErrorMessage(error)}`)
		}
	},

	setAutoEnableDefault: async (provider, message) => {
		try {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				provider.log("Cannot set auto-enable default: No workspace folder open")
				return
			}
			// Capture prior state for every manager before persisting the global change
			const allManagers = CodeIndexManager.getAllInstances()
			const priorStates = new Map(allManagers.map((m) => [m, m.isWorkspaceEnabled]))
			await manager.setAutoEnableDefault(message.bool ?? true)
			// Apply stop/start to every affected manager
			for (const m of allManagers) {
				const wasEnabled = priorStates.get(m)!
				const isNowEnabled = m.isWorkspaceEnabled
				if (wasEnabled && !isNowEnabled) {
					m.stopIndexing()
				} else if (!wasEnabled && isNowEnabled && m.isFeatureEnabled && m.isFeatureConfigured) {
					await m.initialize(provider.contextProxy)
					m.startIndexing()
				}
			}
			provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: manager.getCurrentStatus(),
			})
		} catch (error) {
			provider.log(`Error setting auto-enable default: ${toErrorMessage(error)}`)
		}
	},

	clearIndexData: async (provider) => {
		try {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				provider.log("Cannot clear index data: No workspace folder open")
				provider.postMessageToWebview({
					type: "indexCleared",
					values: {
						success: false,
						error: t("embeddings:orchestrator.indexingRequiresWorkspace"),
					},
				})
				return
			}
			await manager.clearIndexData()
			provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
		} catch (error) {
			provider.log(`Error clearing index data: ${toErrorMessage(error)}`)
			provider.postMessageToWebview({
				type: "indexCleared",
				values: {
					success: false,
					error: toErrorMessage(error),
				},
			})
		}
	},
}
