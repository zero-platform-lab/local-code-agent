/**
 * `saveApiConversationHistory` を最大 3 回、指数バックオフ的な間隔でリトライするヘルパー。
 *
 * delegation フローで `flushPendingToolResultsToHistory` が失敗を返した際に呼ばれる。
 * リトライ間隔: 100 ms → 500 ms → 1500 ms。すべて失敗すると false。
 */
export interface RetrySaveApiConversationHistoryHost {
	taskId: string
	saveApiConversationHistory: () => Promise<boolean>
}

export interface RetrySaveApiConversationHistoryDeps {
	host: RetrySaveApiConversationHistoryHost
}

export async function retrySaveApiConversationHistory(deps: RetrySaveApiConversationHistoryDeps): Promise<boolean> {
	const delays = [100, 500, 1500]
	const { host } = deps

	for (let attempt = 0; attempt < delays.length; attempt++) {
		await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
		console.warn(
			`[Task#${host.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
		)

		const success = await host.saveApiConversationHistory()

		if (success) {
			return true
		}
	}

	return false
}
