import type { ContentBlockParam } from "@openai-agent/types"
import type { ModelInfo, AgentMessage } from "@openai-agent/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../types"
import { ApiStream } from "../transform/stream"
import { countTokens } from "../../utils/countTokens"

/**
 * JSON Schema を再帰的に走査し、**nullable 型配列**（例: `type: ["string","null"]`）を
 * null を除いた型に平坦化する（残りが1つなら単一型に、複数なら配列のまま）。
 *
 * 一部の endpoint/proxy は function tools のスキーマに JSON Schema の nullable 型配列が
 * あると **400 (no body)** で弾く。実ツール群（execute_command 等）が `["string","null"]`
 * を含んでおり、これで Azure GPT-5.4 が 400 になっていた。
 */
export function flattenNullableTypes(node: any): any {
	if (Array.isArray(node)) {
		return node.map(flattenNullableTypes)
	}
	if (node && typeof node === "object") {
		const out: Record<string, any> = {}
		for (const [key, value] of Object.entries(node)) {
			if (key === "type" && Array.isArray(value)) {
				const nonNull = (value as unknown[]).filter((t) => t !== "null")
				out[key] = nonNull.length === 1 ? nonNull[0] : nonNull
			} else {
				out[key] = flattenNullableTypes(value)
			}
		}
		return out
	}
	return node
}

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	abstract createMessage(
		systemPrompt: string,
		messages: AgentMessage[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	abstract getModel(): { id: string; info: ModelInfo }

	/**
	 * ツール定義を chat.completions / responses に渡せる形にする。
	 *
	 * strict は付けない（Azure の strict function calling はスキーマを grammar にコンパイル
	 * するため、ツールが多いとハング/遅延することがあった）。**ただし nullable 型配列
	 * （`type: ["string","null"]`）だけは単一型に平坦化する**。一部の endpoint/proxy は
	 * function tools のスキーマに JSON Schema の nullable 型配列があると **400 (no body)** で
	 * 弾く（実際 Azure GPT-5.4 で、`["string","null"]` を含む実ツール群が 400 になっていた。
	 * curl では `type:"string"` 単一のツールは 200、`["string","null"]` は 400）。
	 *
	 * これは 0.7.9 で strict と一緒に削除してしまった整形（`convertToolSchemaForOpenAI`）の
	 * うち、実害のある「nullable 型の平坦化」だけを復活させたもの。additionalProperties や
	 * required の強制は付けない（endpoint はそれ無しでも受け付けるため）。
	 */
	protected convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}
		return tools.map((tool) => {
			// nullable 型配列を単一型へ平坦化（deep copy が返る）。
			const t = flattenNullableTypes(tool)
			// **strict は剥がす**（非 strict 方針・0.7.9）。個別ツール定義が strict:true を
			// 直書きしていても除去する。strict:true はスキーマが strict 要件（全 property が
			// required 等）を満たさないと endpoint に **400 (no body)** で弾かれる。実際
			// read_file が `required:["path"]` のみ（プロパティ5個）で strict:true を持っており、
			// これでツール付きリクエストが 400 になっていた。
			if (t?.type === "function" && t.function && t.function.strict !== undefined) {
				delete t.function.strict
			}
			return t
		})
	}

	/**
	 * Default token counting implementation using tiktoken.
	 * Providers can override this to use their native token counting endpoints.
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	async countTokens(content: ContentBlockParam[]): Promise<number> {
		if (content.length === 0) {
			return 0
		}

		return countTokens(content, { useWorker: true })
	}
}
