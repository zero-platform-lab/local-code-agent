/**
 * 拡張の内部会話履歴の型。
 *
 * 実プロバイダは OpenAI Compatible のみで、将来的にも同じ位置づけの実装
 * （vLLM / Azure OpenAI / Ollama など）だけを扱う予定なので、内部表現も
 * OpenAI Responses API の item 列を基礎にする。
 *
 * これ以前は Anthropic 形式（`Anthropic.Messages.MessageParam[]`）を持ち回っており、
 * プロバイダに送るたびに変換関数（convertToOpenAiMessages / convertToResponsesInput /
 * convertToR1Format）を通していた。以下 2 つの実害があった:
 *
 * 1. 「新機能は変換関数を書き足せば済む」ため負債が増え続けた。実プロバイダが
 *    1 個しかないのに変換層が肥大した
 * 2. reasoning items のように「Anthropic 型に無いフィールド」を content 配列に
 *    後付けする形で紛れ込ませる必要があり、型が事実と乖離した
 *
 * 内部表現を Responses 形式にすると、以下が得られる:
 *
 * - Chat Completions 経路以外の変換関数がゼロになる（handler が直接消費）
 * - OpenAI SDK の型追随が素直（SDK に新オプションが増えるたび、変換を挟まずに
 *   拡張できる）
 * - reasoning / function_call / tool_result が **独立 item** として並び、
 *   content 配列にごちゃ混ぜにする必要が無くなる
 *
 * 命名は「AgentMessage」だが、これは「1 メッセージ」ではなく「item 列の 1 要素」を指す。
 * Responses API の `input`/`output` が item の配列であり、我々の会話履歴もそれに揃える。
 */

/**
 * Responses API の input item を最小限に再宣言。
 *
 * `openai` パッケージ本体はプロバイダ実装側でのみ import する（packages/types は
 * 軽量に保つため）。ここでは「拡張が内部で持ち回るために必要な形」だけを型化し、
 * プロバイダ側で SDK 型と互換であることを as で担保する。
 *
 * SDK が新しい item type を足したときは、対応してこちらも足す。ただし SDK 側の
 * リアクション型（`response.*` イベント）は入力には使わないため対象外。
 */

/** 会話メッセージ（EasyInputMessage 相当）。role と content の 2 種のみ扱う。 */
export interface AgentMessageMessageItem {
	type: "message"
	role: "user" | "assistant" | "system" | "developer"
	/**
	 * SDK が受け付ける形（`string | ResponseInputContent[]`）。
	 * 内部で持ち回るときは string を推奨し、複雑な content は後付けする。
	 */
	content: string | AgentMessageContentPart[]
}

/** メッセージ内 content の 1 パート。 */
export type AgentMessageContentPart =
	| { type: "input_text"; text: string }
	| { type: "output_text"; text: string; annotations?: unknown[] }
	| { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }

/** 関数呼び出しの発生（assistant → tool）。 */
export interface AgentMessageFunctionCallItem {
	type: "function_call"
	call_id: string
	name: string
	/** arguments は JSON 文字列。SDK と一致。 */
	arguments: string
	id?: string
}

/** 関数呼び出しの結果（tool → assistant）。 */
export interface AgentMessageFunctionCallOutputItem {
	type: "function_call_output"
	call_id: string
	output: string
}

/**
 * 推論（reasoning）item。GPT-5 系の思考の連続性を multi-turn で保つために
 * `encrypted_content` を持ち回る。
 */
export interface AgentMessageReasoningItem {
	type: "reasoning"
	/** SDK 上は暗号化された不透明バイト列。プレーンテキストは持たない。 */
	encrypted_content?: string
	/** SDK が返す要約。text だけの item もある。 */
	summary?: unknown[]
	id?: string
}

/** すべての item 種類の union。 */
export type AgentMessageItemBase =
	| AgentMessageMessageItem
	| AgentMessageFunctionCallItem
	| AgentMessageFunctionCallOutputItem
	| AgentMessageReasoningItem

/**
 * 会話履歴 1 要素。SDK 型に拡張独自メタデータを被せる形。
 */
export type AgentMessageItem = AgentMessageItemBase & AgentMessageMeta

/**
 * 拡張独自のメタデータ。SDK 型を汚さないよう optional で被せる。
 * 永続化される JSON にはそのまま乗る。
 */
export interface AgentMessageMeta {
	/** タイムスタンプ (Date.now())。UI 表示・追跡用。 */
	ts?: number
	/** condenseContext が書いたサマリメッセージであることを示す。 */
	isSummary?: boolean
	/** condense: このメッセージが後段でサマリに置き換えられる場合の相手のID。 */
	condenseParent?: string
	/** condense: サマリ側の一意 ID。 */
	condenseId?: string
	/** truncation: 切り詰めマーカー側の一意 ID。 */
	truncationId?: string
	/** truncation: このメッセージを隠すマーカーの truncationId。 */
	truncationParent?: string
	/** truncation: この item 自体が切り詰め境界マーカーであることを示す。 */
	isTruncationMarker?: boolean
	/** プロバイダが返した応答 ID（OpenAI: response.id）。 */
	id?: string
}

/**
 * 会話履歴（Task が持ち回るもの）の型。
 * 名前は元の慣習を残して `AgentMessage` としているが、実体は item の配列。
 */
export type AgentMessage = AgentMessageItem
