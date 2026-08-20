/**
 * Defines profiles for different embedding models, including their dimensions.
 */

import type { EmbedderProvider, EmbeddingModelProfiles } from "@openai-agent/types"

// Example profiles - expand this list as needed
export const EMBEDDING_MODEL_PROFILES: EmbeddingModelProfiles = {
	"openai-compatible": {
		"text-embedding-3-small": { dimension: 1536, scoreThreshold: 0.4 },
		"text-embedding-3-large": { dimension: 3072, scoreThreshold: 0.4 },
		"text-embedding-ada-002": { dimension: 1536, scoreThreshold: 0.4 },
		"nomic-embed-code": {
			dimension: 3584,
			scoreThreshold: 0.15,
			queryPrefix: "Represent this query for searching relevant code: ",
		},
	},
}

/**
 * Retrieves the embedding dimension for a given provider and model ID.
 * @param provider The embedder provider (e.g., "openai").
 * @param modelId The specific model ID (e.g., "text-embedding-3-small").
 * @returns The dimension size or undefined if the model is not found.
 */
export function getModelDimension(provider: EmbedderProvider, modelId: string): number | undefined {
	const providerProfiles = EMBEDDING_MODEL_PROFILES[provider]
	if (!providerProfiles) {
		console.warn(`Provider not found in profiles: ${provider}`)
		return undefined
	}

	const modelProfile = providerProfiles[modelId]
	if (!modelProfile) {
		// Don't warn here, as it might be a custom model ID not in our profiles
		// console.warn(`Model not found for provider ${provider}: ${modelId}`)
		return undefined // Or potentially return a default/fallback dimension?
	}

	return modelProfile.dimension
}

/**
 * Retrieves the score threshold for a given provider and model ID.
 * @param provider The embedder provider (e.g., "openai").
 * @param modelId The specific model ID (e.g., "text-embedding-3-small").
 * @returns The score threshold or undefined if the model is not found.
 */
export function getModelScoreThreshold(provider: EmbedderProvider, modelId: string): number | undefined {
	const providerProfiles = EMBEDDING_MODEL_PROFILES[provider]
	if (!providerProfiles) {
		return undefined
	}

	const modelProfile = providerProfiles[modelId]
	return modelProfile?.scoreThreshold
}

/**
 * Retrieves the query prefix for a given provider and model ID.
 * @param provider The embedder provider (e.g., "openai").
 * @param modelId The specific model ID (e.g., "nomic-embed-code").
 * @returns The query prefix or undefined if the model doesn't require one.
 */
export function getModelQueryPrefix(provider: EmbedderProvider, modelId: string): string | undefined {
	const providerProfiles = EMBEDDING_MODEL_PROFILES[provider]
	if (!providerProfiles) {
		return undefined
	}

	const modelProfile = providerProfiles[modelId]
	return modelProfile?.queryPrefix
}

/**
 * Gets the default *specific* embedding model ID based on the provider.
 * Does not include the provider prefix.
 * Currently defaults to OpenAI's 'text-embedding-3-small'.
 * TODO: Make this configurable or more sophisticated.
 * @param provider The embedder provider.
 * @returns The default specific model ID for the provider (e.g., "text-embedding-3-small").
 */
export function getDefaultModelId(_provider: EmbedderProvider): string {
	// [INTERNAL] Only the OpenAI Compatible embedder is supported in this build.
	return "text-embedding-3-small"
}
