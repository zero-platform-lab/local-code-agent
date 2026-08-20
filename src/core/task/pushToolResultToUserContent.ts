/**
 * userMessageContent へ tool_result ブロックを追加する。ただし同じ tool_use_id の
 * 結果が既に入っている場合は追加せず false を返す（重複回避）。
 *
 * 並列ツール実行や再送処理で同じ tool_use_id の tool_result が二重に届く可能性が
 * あり、追加すると Anthropic API が拒否する（tool_use に対して tool_result は1つ）。
 */
import type { ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
export function pushToolResultToUserContent(
	userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[],
	toolResult: ToolResultBlockParam,
): boolean {
	const existingResult = userMessageContent.find(
		(block): block is ToolResultBlockParam =>
			block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
	)
	if (existingResult) {
		console.warn(
			`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
		)
		return false
	}
	userMessageContent.push(toolResult)
	return true
}
