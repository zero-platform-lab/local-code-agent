export interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

export interface PendingEditData {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
}

/**
 * メッセージ編集の保留操作（チェックポイント復元前後の pending edit）を管理する。
 * 各操作は自動タイムアウトで掃除される。ClineProvider から HAS-A で切り出した
 * 自己完結クラスタで、依存は log コールバックのみ。
 */
export class PendingEditOperationManager {
	private static readonly TIMEOUT_MS = 30000 // 30 seconds
	private readonly operations = new Map<string, PendingEditOperation>()

	constructor(private readonly log: (message: string) => void) {}

	/**
	 * 保留編集操作を登録する（自動タイムアウト掃除つき）。
	 */
	set(operationId: string, editData: PendingEditData): void {
		// Clear any existing operation with the same ID
		this.clear(operationId)

		// Create timeout for automatic cleanup
		const timeoutId = setTimeout(() => {
			this.clear(operationId)
			this.log(`[setPendingEditOperation] Automatically cleared stale pending operation: ${operationId}`)
		}, PendingEditOperationManager.TIMEOUT_MS)

		// Store the operation
		this.operations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.log(`[setPendingEditOperation] Set pending operation: ${operationId}`)
	}

	/**
	 * ID で保留編集操作を取得する。
	 */
	get(operationId: string): PendingEditOperation | undefined {
		return this.operations.get(operationId)
	}

	/**
	 * 特定の保留編集操作を解除する。
	 */
	clear(operationId: string): boolean {
		const operation = this.operations.get(operationId)
		if (operation) {
			clearTimeout(operation.timeoutId)
			this.operations.delete(operationId)
			this.log(`[clearPendingEditOperation] Cleared pending operation: ${operationId}`)
			return true
		}
		return false
	}

	/**
	 * すべての保留編集操作を解除する（メモリリーク防止）。
	 */
	clearAll(): void {
		for (const [, operation] of this.operations) {
			clearTimeout(operation.timeoutId)
		}
		this.operations.clear()
		this.log(`[clearAllPendingEditOperations] Cleared all pending operations`)
	}
}
