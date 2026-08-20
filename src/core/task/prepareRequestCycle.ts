import type { ContentBlockParam, MessageParam } from "@openai-agent/types"
import type { ClineApiReqInfo } from "@openai-agent/types"

import { getEnvironmentDetails, type EnvironmentDetailsHost } from "../environment/getEnvironmentDetails"

import { applySlashCommandModeSwitch, type SlashCommandModeHost } from "./applySlashCommandModeSwitch"
import {
	persistUserMessageAndPlaceholder,
	type PersistUserMessageAndPlaceholderStateHost,
} from "./persistUserMessageAndPlaceholder"
import {
	prepareUserContentForRequest,
	type PrepareUserContentHost,
	type PrepareUserContentProvider,
} from "./prepareUserContentForRequest"
import { stripDuplicateEnvironmentDetails } from "./stripDuplicateEnvironmentDetails"

/**
 * 1 request 分の準備フェーズをまとめた module。
 *
 *   provider rate limit wait
 *   → stampLastGlobalApiRequestTime
 *   → prepareUserContentForRequest（placeholder api_req_started + @ mention 展開）
 *   → applySlashCommandModeSwitch（slash command のモード切替）
 *   → getEnvironmentDetails
 *   → persistUserMessageAndPlaceholder（env_details 追記 + user message 登録 + placeholder 更新）
 *
 * 返り値は後段の streaming フェーズで使う `lastApiReqIndex`。
 */
export type PrepareRequestCycleHost = PrepareUserContentHost &
	EnvironmentDetailsHost &
	PersistUserMessageAndPlaceholderStateHost & {
		say: (type: "api_req_started", text: string) => Promise<unknown>
		maybeWaitForProviderRateLimit: (retryAttempt: number) => Promise<unknown>
		addToApiConversationHistory: (message: MessageParam) => Promise<unknown>
		saveClineMessages: () => Promise<unknown>
		postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
	}

export interface PrepareRequestCycleDeps {
	host: PrepareRequestCycleHost
	provider?: PrepareUserContentProvider & SlashCommandModeHost
	stampLastGlobalApiRequestTime: () => void
}

export interface PrepareRequestCycleInput {
	currentUserContent: ContentBlockParam[]
	retryAttempt: number
	userMessageWasRemoved: boolean
	isEmptyOriginalUserContent: boolean
	includeFileDetails: boolean
	apiProtocol: NonNullable<ClineApiReqInfo["apiProtocol"]>
}

export interface PrepareRequestCycleResult {
	lastApiReqIndex: number
}

export async function prepareRequestCycle(
	deps: PrepareRequestCycleDeps,
	input: PrepareRequestCycleInput,
): Promise<PrepareRequestCycleResult> {
	const { host } = deps
	await host.maybeWaitForProviderRateLimit(input.retryAttempt)
	deps.stampLastGlobalApiRequestTime()

	const { parsedUserContent, slashCommandMode } = await prepareUserContentForRequest(
		{ host, provider: deps.provider, say: host.say.bind(host) },
		input.currentUserContent,
		input.apiProtocol,
	)

	// Switch mode if specified in a slash command's frontmatter
	await applySlashCommandModeSwitch(deps.provider, slashCommandMode)

	const environmentDetails = await getEnvironmentDetails(host, input.includeFileDetails)

	return persistUserMessageAndPlaceholder(
		{
			host,
			addToApiConversationHistory: host.addToApiConversationHistory.bind(host),
			saveClineMessages: host.saveClineMessages.bind(host),
			postStateToWebviewWithoutTaskHistory: host.postStateToWebviewWithoutTaskHistory.bind(host),
		},
		{
			contentWithoutEnvDetails: stripDuplicateEnvironmentDetails(parsedUserContent),
			environmentDetails,
			retryAttempt: input.retryAttempt,
			userMessageWasRemoved: input.userMessageWasRemoved,
			isEmptyOriginalUserContent: input.isEmptyOriginalUserContent,
			apiProtocol: input.apiProtocol,
		},
	)
}
