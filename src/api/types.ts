import type { ContentBlockParam } from "@openai-agent/types"
import type OpenAI from "openai"

import type { ModelInfo, AgentMessage } from "@openai-agent/types"

import type { ApiStream } from "./transform/stream"

// Shared api handler types. Extracted from `./index` so the concrete providers
// (./providers/openai.ts, ./providers/fake-ai.ts, ./providers/base-provider.ts)
// can consume these shapes without importing `./index`, which in turn imports
// the providers back through `./providers` — breaking the barrel cycle.

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

export interface ApiHandlerCreateMessageMetadata {
	/**
	 * Task ID used for tracking and provider-specific features:
	 * - Agent: Sent as X-Agent-Task-ID header
	 * - Requesty: Sent as trace_id
	 */
	taskId: string
	/**
	 * Optional array of tool definitions to pass to the model.
	 * For OpenAI-compatible providers, these are ChatCompletionTool definitions.
	 */
	tools?: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * Controls which (if any) tool is called by the model.
	 * Can be "none", "auto", "required", or a specific tool choice.
	 */
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	/**
	 * Controls whether the model can return multiple tool calls in a single response.
	 * When true (default), parallel tool calls are enabled (OpenAI's parallel_tool_calls=true).
	 * When false, only one tool call is returned per response.
	 */
	parallelToolCalls?: boolean
}

export interface ApiHandler {
	/**
	 * @param messages 内部会話履歴。OpenAI Responses API の item 列を基礎にした
	 *                 `AgentMessage[]` を受け取る。プロバイダ側はここから直接
	 *                 プロバイダ固有形式に組み立てる（Chat Completions 経路は
	 *                 handler 内で inline 変換する）。
	 */
	createMessage(systemPrompt: string, messages: AgentMessage[], metadata?: ApiHandlerCreateMessageMetadata): ApiStream

	getModel(): { id: string; info: ModelInfo }

	/**
	 * Counts tokens for content blocks
	 * All providers extend BaseProvider which provides a default tiktoken implementation,
	 * but they can override this to use their native token counting endpoints
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	countTokens(content: Array<ContentBlockParam>): Promise<number>
}
