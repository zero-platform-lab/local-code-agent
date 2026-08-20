/**
 * 与えられた user content から `<environment_details>...</environment_details>`
 * だけからなる text block を全て除去する。
 *
 * タスク再開時など、直前セッションの user message に env_details が
 * 埋まったまま残っているケースがあり、fresh な env_details を後段で足す前に
 * 古いブロックを取り除くために使う。
 *
 * 検出条件は「trim 後に `<environment_details>` で始まり `</environment_details>`
 * で終わる text block」。通常テキスト中でタグに言及しているだけのブロックは
 * 除去しないよう、開閉タグの両端一致を確認している。
 */
import type { ContentBlockParam } from "@openai-agent/types"
export function stripDuplicateEnvironmentDetails(userContent: ContentBlockParam[]): ContentBlockParam[] {
	return userContent.filter((block) => {
		if (block.type === "text" && typeof block.text === "string") {
			const trimmed = block.text.trim()
			const isEnvironmentDetailsBlock =
				trimmed.startsWith("<environment_details>") && trimmed.endsWith("</environment_details>")
			return !isEnvironmentDetailsBlock
		}
		return true
	})
}
