import type { AgentMessage } from "@openai-agent/types"

import { migrateLegacyApiMessages } from "./migrateLegacyApiMessages"
import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

export type ApiMessage = AgentMessage

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	if (await fileExistsAtPath(filePath)) {
		const fileContent = await fs.readFile(filePath, "utf8")
		try {
			const parsedData = JSON.parse(fileContent)
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readApiMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${filePath}`,
				)
				return []
			}
			if (parsedData.length === 0) {
				console.error(
					`[Agent-Debug] readApiMessages: Found API conversation history file, but it's empty (parsed as []). TaskId: ${taskId}, Path: ${filePath}`,
				)
			}
			return migrateLegacyApiMessages(parsedData)
		} catch (error) {
			console.warn(
				`[readApiMessages] Error parsing API conversation history file, returning empty. TaskId: ${taskId}, Path: ${filePath}, Error: ${error}`,
			)
			return []
		}
	} else {
		const oldPath = path.join(taskDir, "claude_messages.json")

		if (await fileExistsAtPath(oldPath)) {
			const fileContent = await fs.readFile(oldPath, "utf8")
			let migrated: ApiMessage[]
			try {
				const parsedData = JSON.parse(fileContent)
				if (!Array.isArray(parsedData)) {
					console.warn(
						`[readApiMessages] Parsed OLD data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${oldPath}`,
					)
					return []
				}
				if (parsedData.length === 0) {
					console.error(
						`[Agent-Debug] readApiMessages: Found OLD API conversation history file (claude_messages.json), but it's empty (parsed as []). TaskId: ${taskId}, Path: ${oldPath}`,
					)
				}
				migrated = migrateLegacyApiMessages(parsedData)
			} catch (error) {
				console.warn(
					`[readApiMessages] Error parsing OLD API conversation history file (claude_messages.json), returning empty. TaskId: ${taskId}, Path: ${oldPath}, Error: ${error}`,
				)
				// DO NOT unlink oldPath if parsing failed.
				return []
			}

			// 旧ファイルを消す前に、必ず新ファイルへ書き切る。
			//
			// 以前は読んだ直後に unlink していたが、移行結果を保存するのは呼び出し側だった。
			// 呼び出し側（resumeTaskFromHistory）は読み込み直後に「タスクを再開しますか」で
			// ユーザーの応答を待つので、その間に VS Code を閉じられると履歴がどこにも残らない。
			// 待ち時間に上限は無いので、窓は理論上いくらでも開く。
			//
			// unlink を try の外に出しているのも意図的。削除が EPERM などで失敗したときに
			// パース成功済みの履歴を捨てて [] を返してしまうのを避ける。旧ファイルが残るのは
			// 実害が無い（次回また移行される）が、履歴を失うのは取り返しがつかない。
			await safeWriteJson(filePath, migrated)
			try {
				await fs.unlink(oldPath)
			} catch (error) {
				console.warn(
					`[readApiMessages] Migrated to ${filePath} but failed to remove the old file. TaskId: ${taskId}, Path: ${oldPath}, Error: ${error}`,
				)
			}
			return migrated
		}
	}

	// If we reach here, neither the new nor the old history file was found.
	console.error(
		`[Agent-Debug] readApiMessages: API conversation history file not found for taskId: ${taskId}. Expected at: ${filePath}`,
	)
	return []
}

export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
}) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	await safeWriteJson(filePath, messages)
}
