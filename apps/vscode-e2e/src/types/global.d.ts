import type { AgentAPI } from "@openai-agent/types"

import type { FakeOpenAiServer } from "../suite/fakeOpenAiServer"

declare global {
	// eslint-disable-next-line no-var
	var api: AgentAPI
	// The loaded extension's command/view prefix (== its package name): "openai-agent" in dev,
	// "openai-compatible-agent" for the built internal extension.
	// eslint-disable-next-line no-var
	var commandPrefix: string
	// 実エンドポイントを指定していないときだけ立つ、フェイクの OpenAI 互換サーバ。
	// eslint-disable-next-line no-var
	var fakeOpenAiServer: FakeOpenAiServer | undefined
}

export {}
