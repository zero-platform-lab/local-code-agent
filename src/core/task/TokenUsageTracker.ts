import debounce from "lodash.debounce"

import { AgentEventName, type TokenUsage, type ToolUsage, type ToolName, type ClineMessage } from "@openai-agent/types"

import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"

/**
 * TokenUsageTracker の host。Task を直接渡す narrow 形式。
 * `clineMessages` は field、emit は EventEmitter 継承 method で満たす。
 */
export interface TokenUsageTrackerHost {
	taskId: string
	messageStore: { clineMessages: ClineMessage[] }
	emit(
		event: typeof AgentEventName.TaskTokenUsageUpdated,
		taskId: string,
		tokenUsage: TokenUsage,
		toolUsage: ToolUsage,
	): unknown
	emit(event: typeof AgentEventName.TaskToolFailed, taskId: string, toolName: ToolName, error: string): unknown
}

/**
 * タスクのトークン/ツール使用量の算出・スナップショットキャッシュ・
 * デバウンス emit（throttle 相当）を所有する。Task から分離した UsageTracker。
 * 挙動は元の Task 実装を逐語で保持する。
 */
export class TokenUsageTracker {
	/** ツールごとの試行/失敗回数（実体）。Task からは getter/setter プロキシで公開される。 */
	toolUsage: ToolUsage = {}

	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number
	private toolUsageSnapshot?: ToolUsage
	private readonly debouncedEmit: ReturnType<typeof debounce>

	constructor(
		private readonly host: TokenUsageTrackerHost,
		intervalMs: number,
	) {
		// Initialize debounced token usage emit function
		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates (throttle behavior)
		this.debouncedEmit = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.host.emit(AgentEventName.TaskTokenUsageUpdated, this.host.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.tokenUsageSnapshotAt = this.host.messageStore.clineMessages.at(-1)?.ts
					// Deep copy tool usage for snapshot
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			intervalMs,
			{ leading: true, trailing: true, maxWait: intervalMs },
		)
	}

	/** clineMessages から現在のトークン使用量を算出（先頭=task メッセージは除外）。 */
	getTokenUsage(): TokenUsage {
		return getApiMetrics(combineApiRequests(combineCommandSequences(this.host.messageStore.clineMessages.slice(1))))
	}

	/** キャッシュがあれば返し、無ければ算出してキャッシュする。 */
	getCachedTokenUsage(): TokenUsage {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.host.messageStore.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	/** デバウンス付きで使用量更新を通知する。 */
	emitDebounced(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
		this.debouncedEmit(tokenUsage, toolUsage)
	}

	/** 保留中のデバウンス emit を即時 flush する。 */
	flush(): void {
		this.debouncedEmit.flush()
	}

	/**
	 * 現在の使用量を計算して即時 emit する（throttle を無視）。
	 * タスク完了・abort 前に最終統計を確実にキャプチャする用途。
	 */
	emitFinal(): void {
		const tokenUsage = this.getTokenUsage()
		this.emitDebounced(tokenUsage, this.toolUsage)
		this.flush()
	}

	/** ツールの試行回数を記録する。 */
	recordToolUsage(toolName: ToolName): void {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	/** ツールの失敗回数を記録し、error があれば TaskToolFailed を発火する。 */
	recordToolError(toolName: ToolName, error?: string): void {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.host.emit(AgentEventName.TaskToolFailed, this.host.taskId, toolName, error)
		}
	}
}
