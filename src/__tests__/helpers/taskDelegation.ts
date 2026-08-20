import { TaskDelegationController } from "../../core/webview/TaskDelegationController"

/**
 * テスト用ヘルパ: 委譲ロジックは TaskDelegationController に移動したため、
 * 従来 ClineProvider.prototype.delegateParentAndOpenChild を fake provider に
 * bind して呼んでいたテストは、fake provider の mock メソッドへ委譲する
 * controller を組み立てて呼ぶ。assertion（mock 呼び出し・emit 等）はそのまま。
 */
export function makeDelegationController(provider: any): TaskDelegationController {
	return new TaskDelegationController({
		log: (message) => provider.log?.(message),
		emit: (eventName, ...args) => provider.emit?.(eventName, ...args),
		getCurrentTask: () => provider.getCurrentTask?.(),
		removeClineFromStack: (options) => provider.removeClineFromStack?.(options),
		handleModeSwitch: (mode) => provider.handleModeSwitch?.(mode),
		createTask: (text, images, parentTask, options) => provider.createTask?.(text, images, parentTask, options),
		createTaskWithHistoryItem: (historyItem, options) => provider.createTaskWithHistoryItem?.(historyItem, options),
		getTaskWithId: (id) => provider.getTaskWithId?.(id),
		updateTaskHistory: (item) => provider.updateTaskHistory?.(item),
		globalStoragePath:
			provider.contextProxy?.globalStorageUri?.fsPath ?? provider.globalStoragePath ?? "/test/storage",
	})
}
