import { AgentEventName, type ProviderSettings } from "@openai-agent/types"

import type { TaskProviderRef } from "./taskProviderRef"
import type { TaskSubscription } from "./TaskSubscriptions"

/**
 * provider profile 変更（別 API 設定へ切替）を購読して Task の api configuration を
 * 追随させる。
 *
 * provider は **WeakRef 越しにしか触らない**。teardown 用の closure が provider を
 * 強参照すると、Task が生きている間 ClineProvider が GC されなくなるため
 * （旧実装が `disposeTask` 側で `host.providerRef.deref()` していたのと同じ理由）。
 *
 * provider が emitter interface を持たない（test mock 等）場合は購読せず `undefined`
 * を返す。以降 profile 変更は届かない — 旧 `setupProviderProfileChangeListener` と同じ。
 */
export interface ProviderProfileChangeHost {
	taskId: string
	instanceId: string
	updateApiConfiguration: (apiConfiguration: ProviderSettings) => unknown
}

type ProviderProfileEmitter = Pick<TaskProviderRef, "on" | "off" | "getState">

export function subscribeProviderProfileChange(
	host: ProviderProfileChangeHost,
	providerRef: WeakRef<ProviderProfileEmitter>,
): TaskSubscription | undefined {
	const provider = providerRef.deref()

	// Only set up listener if provider has the on method (may not exist in test mocks)
	if (!provider || typeof provider.on !== "function") {
		return undefined
	}

	const listener = async () => {
		const current = providerRef.deref()

		if (!current) {
			return
		}

		try {
			const newState = await current.getState()

			if (newState?.apiConfiguration) {
				host.updateApiConfiguration(newState.apiConfiguration)
			}
		} catch (error) {
			console.error(
				`[Task#${host.taskId}.${host.instanceId}] Failed to update API configuration on profile change:`,
				error,
			)
		}
	}

	provider.on(AgentEventName.ProviderProfileChanged, listener)

	return {
		label: "provider.providerProfileChanged",
		dispose: () => {
			providerRef.deref()?.off(AgentEventName.ProviderProfileChanged, listener)
		},
	}
}
