import type { TodoItem } from "@openai-agent/types"

/**
 * 親タスクから delegation でサブタスクを起動する薄い wrapper。
 *
 * `provider.delegateParentAndOpenChild` を呼ぶだけだが provider が
 * `deref()` 経由でしか取れないため null チェックを含む。
 */
export interface StartSubtaskProvider {
	delegateParentAndOpenChild(input: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
	}): Promise<unknown>
}

export async function startSubtask(
	providerRef: WeakRef<StartSubtaskProvider>,
	parentTaskId: string,
	message: string,
	initialTodos: TodoItem[],
	mode: string,
): Promise<unknown> {
	const provider = providerRef.deref()

	if (!provider) {
		throw new Error("Provider not available")
	}

	return provider.delegateParentAndOpenChild({
		parentTaskId,
		message,
		initialTodos,
		mode,
	})
}
