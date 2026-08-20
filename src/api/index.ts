import { type ProviderSettings } from "@openai-agent/types"

// Shared handler types moved to `./types` (leaf) so provider files can consume
// them without importing back through this barrel. Re-exported here so
// existing `import { ApiHandler, ... } from "../api"` callers keep working.
import type { ApiHandler, ApiHandlerCreateMessageMetadata, SingleCompletionHandler } from "./types"
export type { ApiHandler, ApiHandlerCreateMessageMetadata, SingleCompletionHandler }

// [INTERNAL] Only the OpenAI Compatible provider (and the no-network fake-ai test
// provider) are wired up. Other upstream provider handlers remain in ./providers but
// are intentionally not instantiated — see buildApiHandler below.
import { OpenAiHandler, FakeAIHandler } from "./providers"

export function buildApiHandler(configuration: ProviderSettings): ApiHandler {
	const { apiProvider, ...options } = configuration

	switch (apiProvider) {
		case "openai":
			return new OpenAiHandler(options)
		case "fake-ai":
			// Internal test/faux provider; makes no network calls.
			return new FakeAIHandler(options)
		default:
			// [INTERNAL] Only the OpenAI Compatible provider is supported in this build.
			// Every other upstream provider is intentionally disabled here so the
			// extension can never instantiate a handler that contacts an endpoint other
			// than the OpenAI-compatible one the user explicitly configures — even if a
			// foreign provider is loaded via imported/migrated settings.
			throw new Error(
				`Provider "${apiProvider ?? "(none)"}" is not supported in this build. ` +
					`Please use the OpenAI Compatible provider in your API profile settings.`,
			)
	}
}
