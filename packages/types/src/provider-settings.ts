import { z } from "zod"

import { modelInfoSchema, reasoningEffortSettingSchema, verbosityLevelsSchema } from "./model.js"
import { codebaseIndexProviderSchema } from "./codebase-index.js"

/**
 * constants
 */

export const DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3

/**
 * DynamicProvider
 *
 * Dynamic provider requires external API calls in order to get the model list.
 */

export const dynamicProviders = [] as const

export type DynamicProvider = (typeof dynamicProviders)[number]

/**
 * LocalProvider
 *
 * Local providers require localhost API calls in order to get the model list.
 */

export const localProviders = [] as const

export type LocalProvider = (typeof localProviders)[number]

/**
 * InternalProvider
 *
 * Internal providers require internal VSCode API calls in order to get the
 * model list.
 */

export const internalProviders = [] as const

/**
 * CustomProvider
 *
 * Custom providers are completely configurable within Agent settings.
 */

export const customProviders = ["openai"] as const

/**
 * FauxProvider
 *
 * Faux providers do not make external inference calls and therefore do not have
 * model lists.
 */

export const fauxProviders = ["fake-ai"] as const

/**
 * ProviderName
 */

export const providerNames = [
	...dynamicProviders,
	...localProviders,
	...internalProviders,
	...customProviders,
	...fauxProviders,
] as const

export const providerNamesSchema = z.enum(providerNames)

export type ProviderName = z.infer<typeof providerNamesSchema>

export const isProviderName = (key: unknown): key is ProviderName =>
	typeof key === "string" && providerNames.includes(key as ProviderName)

/**
 * ProviderSettingsEntry
 */

export const providerSettingsEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	apiProvider: providerNamesSchema.optional(),
	modelId: z.string().optional(),
})

export type ProviderSettingsEntry = z.infer<typeof providerSettingsEntrySchema>

/**
 * ProviderSettings
 */

const baseProviderSettingsSchema = z.object({
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	// web_fetch ツールは既定オフ（opt-in）。ネットワーク取得は proxy 制限網で失敗して
	// タスクを脱線させ得るため、明示的に有効化した環境だけモデルへ提示する。
	webFetchEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: z.number().min(0).optional(),

	// Model reasoning.
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),

	// Model verbosity.
	verbosity: verbosityLevelsSchema.optional(),
})

// Several of the providers share common model config properties.
const apiModelIdProviderModelSchema = baseProviderSettingsSchema.extend({
	apiModelId: z.string().optional(),
})

const openAiSchema = baseProviderSettingsSchema.extend({
	openAiBaseUrl: z.string().optional(),
	openAiApiKey: z.string().optional(),
	openAiModelId: z.string().optional(),
	openAiCustomModelInfo: modelInfoSchema.nullish(),
	openAiUseAzure: z.boolean().optional(),
	azureApiVersion: z.string().optional(),
	openAiStreamingEnabled: z.boolean().optional(),
	openAiHeaders: z.record(z.string(), z.string()).optional(),
	// GPT-5 系 (Azure 含む) は /v1/chat/completions で reasoning と tool calling を
	// 併用できず 400 を返す。Responses API (/openai/v1/responses) は両立可能。
	// true にすると chat.completions ではなく responses.create() を使う。
	// 対応する endpoint (Azure OpenAI / OpenAI 本家) 以外では拒否される。
	openAiUseResponsesApi: z.boolean().optional(),
	// chat.completions でツール併用時も reasoning_effort を送る（既定はツール時 "none"）。
	// 実験的: 旧 400 の真因は read_file の strict:true だったため、reasoning+tools が今なら
	// 通る endpoint がある。非対応なら 400/ハングをウォッチドッグ・4xx 終端で表面化する。
	openAiReasoningWithTools: z.boolean().optional(),
})

const fakeAiSchema = baseProviderSettingsSchema.extend({
	fakeAi: z.unknown().optional(),
})

const defaultSchema = z.object({
	apiProvider: z.undefined(),
})

export const providerSettingsSchemaDiscriminated = z.discriminatedUnion("apiProvider", [
	openAiSchema.merge(apiModelIdProviderModelSchema).merge(z.object({ apiProvider: z.literal("openai") })),
	fakeAiSchema.merge(z.object({ apiProvider: z.literal("fake-ai") })),
	defaultSchema,
])

export const providerSettingsSchema = z.object({
	apiProvider: providerNamesSchema.optional(),
	...apiModelIdProviderModelSchema.shape,
	...openAiSchema.shape,
	...fakeAiSchema.shape,
	...codebaseIndexProviderSchema.shape,
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>

export const providerSettingsWithIdSchema = providerSettingsSchema.extend({ id: z.string().optional() })

export const discriminatedProviderSettingsWithIdSchema = providerSettingsSchemaDiscriminated.and(
	z.object({ id: z.string().optional() }),
)

export type ProviderSettingsWithId = z.infer<typeof providerSettingsWithIdSchema>

export const PROVIDER_SETTINGS_KEYS = providerSettingsSchema.keyof().options

/**
 * ModelIdKey
 */

export const modelIdKeys = ["apiModelId", "openAiModelId"] as const satisfies readonly (keyof ProviderSettings)[]

export const getModelId = (settings: ProviderSettings): string | undefined => {
	const modelIdKey = modelIdKeys.find((key) => settings[key])
	return modelIdKey ? settings[modelIdKey] : undefined
}
