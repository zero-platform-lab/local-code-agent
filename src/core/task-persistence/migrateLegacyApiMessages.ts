import type {
	AgentMessage,
	AgentMessageContentPart,
	AgentMessageMeta,
	ContentBlockParam,
	ImageBlockParam,
} from "@openai-agent/types"

/**
 * 旧形式（Anthropic ベースの `{role, content}` メッセージ列）で保存された会話履歴を
 * `AgentMessage[]`（Responses item 列）へ変換する。
 *
 * **読み込み時にだけ**走る。ファイルは書き換えないので、旧バージョンの拡張に戻しても
 * 履歴はそのまま読める（次の保存で新形式に上書きされる点だけ注意）。
 *
 * 1 メッセージが複数 item に割れる（本文 + tool_use N 個 など）ため、メタデータ
 * （ts / condenseParent / truncationParent 等）は**割れた全 item に複製する**。
 * condense と truncation のフィルタはメタで一括除外するので、これで挙動が保たれる。
 */
export function migrateLegacyApiMessages(raw: unknown[]): AgentMessage[] {
	if (!needsMigration(raw)) return raw as AgentMessage[]

	const out: AgentMessage[] = []
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue
		const msg = entry as Record<string, unknown>

		// 既に新形式の item ならそのまま通す（混在履歴の保険）。
		if (typeof msg.type === "string" && msg.type !== "reasoning" && !("role" in msg)) {
			out.push(entry as AgentMessage)
			continue
		}

		const meta = pickMeta(msg)

		// 単独 reasoning（旧形式でも item として並んでいた）。
		if (msg.type === "reasoning" && !("role" in msg)) {
			if (typeof msg.encrypted_content === "string") {
				out.push({
					type: "reasoning",
					encrypted_content: msg.encrypted_content,
					...(Array.isArray(msg.summary) ? { summary: msg.summary } : {}),
					...meta,
				})
			}
			continue
		}

		const role = msg.role
		if (role !== "user" && role !== "assistant") continue

		out.push(...messageToAgentItems(role, msg.content as string | ContentBlockParam[] | undefined, meta))
	}
	return out
}

/**
 * 旧形式が 1 件でも混ざっているか。`role` を持つ要素があれば旧形式とみなす
 * （新形式の item は `role` を message item の中だけで持ち、トップレベルには
 * `type` が必ず付く）。
 */
function needsMigration(raw: unknown[]): boolean {
	return raw.some((e) => {
		if (!e || typeof e !== "object") return false
		const m = e as Record<string, unknown>
		return "role" in m && typeof m.type !== "string"
	})
}

function pickMeta(msg: Record<string, unknown>): AgentMessageMeta {
	const meta: AgentMessageMeta = {}
	if (typeof msg.ts === "number") meta.ts = msg.ts
	if (msg.isSummary === true) meta.isSummary = true
	if (typeof msg.condenseId === "string") meta.condenseId = msg.condenseId
	if (typeof msg.condenseParent === "string") meta.condenseParent = msg.condenseParent
	if (typeof msg.truncationId === "string") meta.truncationId = msg.truncationId
	if (typeof msg.truncationParent === "string") meta.truncationParent = msg.truncationParent
	if (msg.isTruncationMarker === true) meta.isTruncationMarker = true
	if (typeof msg.id === "string") meta.id = msg.id
	return meta
}

/**
 * `{role, content}` 形式の 1 メッセージを AgentMessage item 列に落とす。
 * 旧履歴のマイグレーションと、`addToApiConversationHistory` の書き込み経路で共用する。
 */
export function messageToAgentItems(
	role: "user" | "assistant",
	content: string | ContentBlockParam[] | undefined,
	meta: AgentMessageMeta = {},
): AgentMessage[] {
	const out: AgentMessage[] = []
	if (typeof content === "string") {
		out.push({ type: "message", role, content, ...meta })
		return out
	}
	if (Array.isArray(content)) emitBlocks(out, role, content, meta)
	return out
}

function emitBlocks(
	out: AgentMessage[],
	role: "user" | "assistant",
	blocks: ContentBlockParam[],
	meta: AgentMessageMeta,
): void {
	let buf: AgentMessageContentPart[] = []
	const flush = () => {
		if (buf.length === 0) return
		const hasImage = buf.some((p) => p.type === "input_image")
		// hasImage が false のときは buf は input_text だけ（image を積んだ時点で hasImage=true）。
		// ここで `p.type === "input_image" ? … ` と分岐させると、その真側は原理的に到達しない
		// デッドコードになる。到達可能な分岐だけ残すため input_text へ絞ってから text を取る。
		const textParts = buf as Extract<AgentMessageContentPart, { type: "input_text" }>[]
		out.push({
			type: "message",
			role,
			content: hasImage ? buf : textParts.map((p) => p.text).join("\n"),
			...meta,
		})
		buf = []
	}

	for (const block of blocks) {
		if (!block || typeof block !== "object") continue
		switch (block.type) {
			case "text":
				buf.push({ type: "input_text", text: block.text })
				break
			case "image": {
				const url = imageToDataUrl(block)
				if (url) buf.push({ type: "input_image", image_url: url })
				break
			}
			case "tool_use":
				flush()
				out.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.input ?? {}),
					...meta,
				})
				break
			case "tool_result":
				flush()
				out.push({
					type: "function_call_output",
					call_id: block.tool_use_id,
					output: serializeToolResult(block.content),
					...meta,
				})
				break
			default: {
				// content 配列に紛れ込ませていた reasoning 疑似ブロック。
				const pseudo = block as unknown as Record<string, unknown>
				if (pseudo.type === "reasoning" && typeof pseudo.encrypted_content === "string") {
					flush()
					out.push({
						type: "reasoning",
						encrypted_content: pseudo.encrypted_content,
						...(Array.isArray(pseudo.summary) ? { summary: pseudo.summary } : {}),
						...(typeof pseudo.id === "string" ? { id: pseudo.id } : {}),
						...meta,
					})
				} else if (pseudo.type === "reasoning" && typeof pseudo.text === "string") {
					// 平文 reasoning は Responses item にできないので本文に畳む。
					buf.push({ type: "input_text", text: pseudo.text })
				}
				break
			}
		}
	}
	flush()
}

function imageToDataUrl(block: ImageBlockParam): string | undefined {
	const source = block.source
	if (!source) return undefined
	if (source.type === "url") return source.url
	if (!source.data) return undefined
	return `data:${source.media_type};base64,${source.data}`
}

function serializeToolResult(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			const p = part as Record<string, unknown>
			if (p?.type === "text" && typeof p.text === "string") return p.text
			if (p?.type === "image") return "[image]"
			return ""
		})
		.filter(Boolean)
		.join("\n")
}
