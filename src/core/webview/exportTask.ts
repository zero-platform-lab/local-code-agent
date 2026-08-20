import type { MessageParam } from "@openai-agent/types"
import os from "os"
import * as path from "path"

import type { ContextProxy } from "../config/ContextProxy"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"

/**
 * タスクの API 会話履歴を Markdown ファイルとして書き出す。
 * 既定の保存先解決 → ダウンロード → 最終エクスポートパスの保存まで。
 * ClineProvider の状態には依存せず、ContextProxy とエクスポート情報のみを受け取る。
 */
export async function exportTaskToMarkdown(
	ts: number,
	apiConversationHistory: MessageParam[],
	contextProxy: ContextProxy,
): Promise<void> {
	const fileName = getTaskFileName(ts)
	const defaultUri = await resolveDefaultSaveUri(contextProxy, "lastTaskExportPath", fileName, {
		useWorkspace: false,
		fallbackDir: path.join(os.homedir(), "Downloads"),
	})
	const saveUri = await downloadTask(ts, apiConversationHistory, defaultUri)

	if (saveUri) {
		await saveLastExportPath(contextProxy, "lastTaskExportPath", saveUri)
	}
}
