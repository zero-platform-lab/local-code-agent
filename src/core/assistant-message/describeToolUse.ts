import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolUse } from "../../shared/tools"
import { readFileTool } from "../tools/ReadFileTool"

/**
 * tool 呼び出しをユーザーに見せる 1 行ラベル（`[read_file for 'a.ts']` の形）にする。
 *
 * `presentAssistantMessage` の中に 66 行のクロージャとして埋まっていたもの。承認ダイアログ、
 * 拒否時のメッセージ、attempt_completion への受け渡しの 3 箇所から呼ばれる**純粋な表示ロジック**
 * だったが、Task 相当の host を組まないと 1 ケースも検証できなかった。
 *
 * 引数は tool ブロックとモード一覧だけ。vscode にも Task にも依存しない。
 */
export function describeToolUse(block: ToolUse): string {
	const params = block.params ?? {}

	switch (block.name) {
		case "execute_command":
			return `[${block.name} for '${params.command}']`
		case "read_file":
			// Prefer native typed args when available; fall back to legacy params.
			// `block` は tool 名で判別できない generic なので nativeArgs は全 tool の union に
			// なる。実装は `"path" in second` を見るだけなので、その形にだけ絞って渡す。
			return block.nativeArgs
				? readFileTool.getReadFileToolDescription(block.name, block.nativeArgs as { path?: string })
				: readFileTool.getReadFileToolDescription(block.name, params)
		case "write_to_file":
			return `[${block.name} for '${params.path}']`
		case "apply_diff":
			// Native-only: tool args are structured (no XML payloads).
			return params.path ? `[${block.name} for '${params.path}']` : `[${block.name}]`
		case "search_files":
			return `[${block.name} for '${params.regex}'${params.file_pattern ? ` in '${params.file_pattern}'` : ""}]`
		case "edit":
		case "search_and_replace":
		case "search_replace":
		case "edit_file":
			return `[${block.name} for '${params.file_path}']`
		case "list_files":
			return `[${block.name} for '${params.path}']`
		case "use_mcp_tool":
		case "access_mcp_resource":
			return `[${block.name} for '${params.server_name}']`
		case "ask_followup_question":
			return `[${block.name} for '${params.question}']`
		case "codebase_search":
			return `[${block.name} for '${params.query}']`
		case "read_command_output":
			return `[${block.name} for '${params.artifact_id}']`
		case "new_task": {
			const mode = params.mode ?? defaultModeSlug
			const message = params.message ?? "(no message)"
			return `[${block.name} in ${getModeBySlug(mode)?.name ?? mode} mode: '${message}']`
		}
		case "run_slash_command":
			return `[${block.name} for '${params.command}'${params.args ? ` with args: ${params.args}` : ""}]`
		case "skill":
			return `[${block.name} for '${params.skill}'${params.args ? ` with args: ${params.args}` : ""}]`
		// apply_patch / attempt_completion / update_todo_list は引数を出さない。
		default:
			return `[${block.name}]`
	}
}
