// Integration test for testOpenAiConnection() against a REAL OpenAI-compatible endpoint.
//
// Skipped by default. Runs only when OPENAI_LIVE_BASE_URL points at a reachable
// OpenAI-compatible server (e.g. a local Ollama / vLLM / TGI instance):
//
//   OPENAI_LIVE_BASE_URL=http://localhost:11434/v1 \
//     npx vitest run src/api/providers/__tests__/openaiConnection.live.spec.ts
//
// This complements the fully-mocked unit test in ./testOpenAiConnection.spec.ts,
// which runs everywhere (CI included) with no network. Keeping both means the
// error-classification logic is always covered, while real reachability is
// verified on machines that actually have an endpoint available.
import { describe, it, expect, beforeAll } from "vitest"

import { testOpenAiConnection } from "../openai"
import { allowNetConnect } from "../../../vitest.setup"

const LIVE_BASE_URL = process.env.OPENAI_LIVE_BASE_URL
const LIVE_MODEL_ID = process.env.OPENAI_LIVE_MODEL_ID || "gpt-oss:20b"

describe.skipIf(!LIVE_BASE_URL)("testOpenAiConnection (live endpoint)", () => {
	beforeAll(() => {
		// The global setup disables all real network via nock; re-enable the live host.
		allowNetConnect(new URL(LIVE_BASE_URL as string).host)
	})

	it("succeeds and the model responds against the live endpoint", async () => {
		const result = await testOpenAiConnection(LIVE_BASE_URL, undefined, undefined, LIVE_MODEL_ID)
		expect(result.success).toBe(true)
		expect(result.message).toContain("接続成功")
	})

	it("still succeeds when an (ignored) API key is supplied", async () => {
		// Keyless local endpoints ignore the key; supplying one must not break the check.
		const result = await testOpenAiConnection(LIVE_BASE_URL, "ignored-by-local-endpoint", undefined, LIVE_MODEL_ID)
		expect(result.success).toBe(true)
	})
})
