import type { ToolName } from "@openai-agent/types"

import type { ToolUse } from "../../shared/tools"

import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { applyDiffTool } from "../tools/ApplyDiffTool"
import { applyPatchTool } from "../tools/ApplyPatchTool"
import { askFollowupQuestionTool } from "../tools/AskFollowupQuestionTool"
import { attemptCompletionTool } from "../tools/AttemptCompletionTool"
import { codebaseSearchTool } from "../tools/CodebaseSearchTool"
import { editFileTool } from "../tools/EditFileTool"
import { editTool } from "../tools/EditTool"
import { executeCommandTool } from "../tools/ExecuteCommandTool"
import { listFilesTool } from "../tools/ListFilesTool"
import { newTaskTool } from "../tools/NewTaskTool"
import { readCommandOutputTool } from "../tools/ReadCommandOutputTool"
import { readFileTool } from "../tools/ReadFileTool"
import { runSlashCommandTool } from "../tools/RunSlashCommandTool"
import { searchFilesTool } from "../tools/SearchFilesTool"
import { searchReplaceTool } from "../tools/SearchReplaceTool"
import { skillTool } from "../tools/SkillTool"
import { updateTodoListTool } from "../tools/UpdateTodoListTool"
import { useMcpToolTool } from "../tools/UseMcpToolTool"
import { webFetchTool } from "../tools/WebFetchTool"
import { writeToFileTool } from "../tools/WriteToFileTool"

/**
 * tool 名 → 実行方法の対応表。
 *
 * 分割前は `presentAssistantMessage` の中の 22 ケース・約 176 行の switch で、各ケースが
 * 「checkpoint を取るか」「どの handler を呼ぶか」「追加コールバックがあるか」を毎回手書き
 * していた。同じ 5 行が 22 回並ぶので、**どの tool が checkpoint を取るのか**という肝心な
 * 情報が本文に埋もれていた。ここでは表の 1 列（`savesCheckpoint`）として見えるようにしている。
 *
 * webviewMessageHandler の 122 case switch を dispatch table 化したとき (#102-#108) と同じ方針。
 */

/** 実行時にだけ決まる値。追加コールバックを組む tool が使う。 */
export interface ToolDispatchContext {
	block: ToolUse
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * 各 tool の `handle` は `ToolUse<"その tool">` を要求するが、表に載せる時点では
 * 名前で絞り込めない。分割前も各 case で `block as ToolUse<"write_to_file">` と
 * キャストしていたので、型の緩さは同じ（実際の型検査は tool モジュール側で効いている）。
 */
type ToolHandler = (task: any, block: any, callbacks: any) => Promise<unknown>

export interface ToolDispatchEntry {
	handle: ToolHandler
	/** ファイルを書き換える tool。実行前に checkpoint を保存する。 */
	savesCheckpoint?: true
	/** 既定の 3 コールバック（askApproval / handleError / pushToolResult）に足すもの。 */
	extraCallbacks?: (ctx: ToolDispatchContext) => Record<string, unknown>
}

const entry = (tool: { handle: ToolHandler }, rest: Omit<ToolDispatchEntry, "handle"> = {}): ToolDispatchEntry => ({
	handle: (task, block, callbacks) => tool.handle(task, block, callbacks),
	...rest,
})

export const toolDispatch: Partial<Record<ToolName, ToolDispatchEntry>> = {
	// --- ファイルを書き換える: checkpoint を取ってから実行 ---
	write_to_file: entry(writeToFileTool, { savesCheckpoint: true }),
	apply_diff: entry(applyDiffTool, { savesCheckpoint: true }),
	edit: entry(editTool, { savesCheckpoint: true }),
	search_and_replace: entry(editTool, { savesCheckpoint: true }),
	search_replace: entry(searchReplaceTool, { savesCheckpoint: true }),
	edit_file: entry(editFileTool, { savesCheckpoint: true }),
	apply_patch: entry(applyPatchTool, { savesCheckpoint: true }),
	new_task: entry(newTaskTool, {
		savesCheckpoint: true,
		extraCallbacks: ({ block }) => ({ toolCallId: block.id }),
	}),

	// --- 読み取り・問い合わせ系 ---
	update_todo_list: entry(updateTodoListTool),
	read_file: entry(readFileTool),
	list_files: entry(listFilesTool),
	codebase_search: entry(codebaseSearchTool),
	web_fetch: entry(webFetchTool),
	search_files: entry(searchFilesTool),
	execute_command: entry(executeCommandTool),
	read_command_output: entry(readCommandOutputTool),
	use_mcp_tool: entry(useMcpToolTool),
	access_mcp_resource: entry(accessMcpResourceTool),
	ask_followup_question: entry(askFollowupQuestionTool),
	run_slash_command: entry(runSlashCommandTool),
	skill: entry(skillTool),

	attempt_completion: entry(attemptCompletionTool, {
		extraCallbacks: ({ askFinishSubTaskApproval, toolDescription }) => ({
			askFinishSubTaskApproval,
			toolDescription,
		}),
	}),
}
