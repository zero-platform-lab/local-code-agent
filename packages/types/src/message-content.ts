/**
 * 保存済み会話履歴（`ApiMessage`）で使うコンテンツブロック型。
 *
 * かつては `@anthropic-ai/sdk` の `Anthropic.Messages.*` をそのまま使っていたが、
 * この拡張は OpenAI 互換エンドポイント専用で SDK をランタイムでは一切使っておらず、
 * 型のためだけに本番依存を抱えていた。実際に使っていた 6 種類だけをここに再宣言する。
 *
 * 形は SDK 0.37 の定義に合わせてあるが、この fork で参照が無かった
 * `cache_control` / `citations` と、Document / Thinking 系ブロックは持たない。
 *
 * 送信時は `buildCleanConversationHistory` がここから
 * [[AgentMessage]]（Responses API item 形式）へ変換する。
 */

export interface TextBlockParam {
	type: "text"
	text: string
}

/** base64 が本来の形。url は互換サーバ経由で URL 参照が来た場合の受け皿。 */
export type ImageBlockSource = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }

export interface ImageBlockParam {
	type: "image"
	source: ImageBlockSource
}

export interface ToolUseBlockParam {
	type: "tool_use"
	id: string
	name: string
	input: unknown
}

export interface ToolResultBlockParam {
	type: "tool_result"
	tool_use_id: string
	content?: string | Array<TextBlockParam | ImageBlockParam>
	is_error?: boolean
}

export type ContentBlockParam = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam

export interface MessageParam {
	role: "user" | "assistant"
	content: string | ContentBlockParam[]
}
