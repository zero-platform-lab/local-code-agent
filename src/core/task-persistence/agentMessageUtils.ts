import type { AgentMessage, AgentMessageMessageItem, AgentMessageMeta } from "@openai-agent/types"

/**
 * `AgentMessage`（Responses item 列）を扱うための小さなナローイング群。
 *
 * item 列では 1 ターンが複数要素に割れる（本文 + function_call N 個 など）。
 * 「このターンは user か assistant か」「本文テキストは何か」を素朴に書くと
 * 各所で同じ型ガードを繰り返すことになるので、ここに寄せる。
 */

export type MessageItem = AgentMessageMessageItem & AgentMessageMeta

export function isMessageItem(item: AgentMessage | undefined): item is MessageItem {
	return !!item && item.type === "message"
}

/** message item なら role を返す。それ以外の item は undefined。 */
export function itemRole(item: AgentMessage | undefined): AgentMessageMessageItem["role"] | undefined {
	return isMessageItem(item) ? item.role : undefined
}

/**
 * item が属するターンの話者。
 *
 * - `message` → その role
 * - `function_call` / `reasoning` → assistant が出したもの
 * - `function_call_output` → ツール実行結果なので user 側のターンに属する
 */
export function turnRole(item: AgentMessage | undefined): "user" | "assistant" | undefined {
	if (!item) return undefined
	switch (item.type) {
		case "message":
			return item.role === "assistant" ? "assistant" : "user"
		case "function_call":
		case "reasoning":
			return "assistant"
		case "function_call_output":
			return "user"
	}
}

export function isUserTurn(item: AgentMessage | undefined): boolean {
	return turnRole(item) === "user"
}

export function isAssistantTurn(item: AgentMessage | undefined): boolean {
	return turnRole(item) === "assistant"
}

/**
 * item の本文をプレーンテキストに落とす。トークン概算・文字列マッチ・
 * サマリ検出などに使う。画像はマーカーに落とす。
 */
export function itemText(item: AgentMessage | undefined): string {
	if (!item) return ""
	switch (item.type) {
		case "message":
			if (typeof item.content === "string") return item.content
			return item.content
				.map((p) => (p.type === "input_image" ? "[image]" : p.text))
				.filter(Boolean)
				.join("\n")
		case "function_call":
			return `${item.name}(${item.arguments})`
		case "function_call_output":
			return item.output
		case "reasoning":
			return ""
	}
}

/** message item の content にテキストを差し替えた新しい item を返す。 */
export function withText(item: MessageItem, text: string): MessageItem {
	return { ...item, content: text }
}

/** テキストだけの message item を作る。 */
export function textMessage(role: "user" | "assistant", text: string, meta: AgentMessageMeta = {}): MessageItem {
	return { type: "message", role, content: text, ...meta }
}
