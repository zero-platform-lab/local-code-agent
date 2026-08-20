import { EmbedderProvider } from "./manager"

/**
 * Configuration state for the code indexing feature
 */
export interface CodeIndexConfig {
	isConfigured: boolean
	embedderProvider: EmbedderProvider
	modelId?: string
	modelDimension?: number // Generic dimension property for all providers
	openAiCompatibleOptions?: { baseUrl: string; apiKey: string }
	qdrantUrl?: string
	qdrantApiKey?: string
	searchMinScore?: number
	searchMaxResults?: number
}

/**
 * Snapshot of previous configuration used to determine if a restart is required
 */
export type PreviousConfigSnapshot = {
	enabled: boolean
	configured: boolean
	embedderProvider: EmbedderProvider
	modelId?: string
	modelDimension?: number // Generic dimension property
	openAiCompatibleBaseUrl?: string
	openAiCompatibleApiKey?: string
	qdrantUrl?: string
	qdrantApiKey?: string
}
