export type ApiStream = AsyncGenerator<ApiStreamChunk>

export type ApiStreamChunk =
	| ApiStreamTextChunk
	| ApiStreamUsageChunk
	| ApiStreamReasoningChunk
	| ApiStreamToolCallChunk
	| ApiStreamToolCallStartChunk
	| ApiStreamToolCallDeltaChunk
	| ApiStreamToolCallEndChunk
	| ApiStreamToolCallPartialChunk
	| ApiStreamError

export interface ApiStreamError {
	type: "error"
	error: string
	message: string
}

export interface ApiStreamTextChunk {
	type: "text"
	text: string
}

/** Reasoning/thinking chunk from the API stream. */
export interface ApiStreamReasoningChunk {
	type: "reasoning"
	text: string
}

export interface ApiStreamUsageChunk {
	type: "usage"
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	totalCost?: number
}

export interface ApiStreamToolCallChunk {
	type: "tool_call"
	id: string
	name: string
	arguments: string
}

export interface ApiStreamToolCallStartChunk {
	type: "tool_call_start"
	id: string
	name: string
}

export interface ApiStreamToolCallDeltaChunk {
	type: "tool_call_delta"
	id: string
	delta: string
}

export interface ApiStreamToolCallEndChunk {
	type: "tool_call_end"
	id: string
}

/**
 * Raw tool call chunk from the API stream.
 * Providers emit this simple format; NativeToolCallParser handles all state management
 * (tracking, buffering, emitting start/delta/end events).
 */
export interface ApiStreamToolCallPartialChunk {
	type: "tool_call_partial"
	index: number
	id?: string
	name?: string
	arguments?: string
}
