import type { MessageParam } from "@openai-agent/types"
import * as path from "path"
import fs from "fs/promises"

import type { HistoryItem } from "@openai-agent/types"

import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import type { TaskHistoryStore } from "../task-persistence"
import type { ContextProxy } from "../config/ContextProxy"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { fileExistsAtPath } from "../../utils/fs"

export interface TaskWithId {
	historyItem: HistoryItem
	taskDirPath: string
	apiConversationHistoryFilePath: string
	uiMessagesFilePath: string
	apiConversationHistory: MessageParam[]
}

/**
 * タスク履歴の read 責務（id 引き当て・ディスクからの API 会話履歴読み込み・
 * コスト集計）を ClineProvider から分離したもの。依存は taskHistoryStore /
 * contextProxy / getTaskHistory の3つのみ（狭い interface）。
 *
 * show/delete/condense/export など lifecycle と絡む操作は ClineProvider 側に残す。
 */
export class TaskHistoryReader {
	constructor(
		private readonly taskHistoryStore: TaskHistoryStore,
		private readonly contextProxy: ContextProxy,
		private readonly getTaskHistory: () => HistoryItem[],
	) {}

	async getTaskWithId(id: string): Promise<TaskWithId> {
		const historyItem = this.taskHistoryStore.get(id) ?? this.getTaskHistory().find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				console.warn(
					`[getTaskWithId] api_conversation_history.json corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			console.warn(
				`[getTaskWithId] api_conversation_history.json missing for task ${id}, returning empty history`,
			)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(
		taskId: string,
	): Promise<{ historyItem: HistoryItem; aggregatedCosts: AggregatedCosts }> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			const result = await this.getTaskWithId(id)
			return result.historyItem
		})

		return { historyItem, aggregatedCosts }
	}
}
