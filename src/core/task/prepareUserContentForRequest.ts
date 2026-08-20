import type { ContentBlockParam } from "@openai-agent/types"
import { defaultModeSlug } from "../../shared/modes"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import type { SkillLookup } from "../../services/skills/skillInvocation"
import { processUserContentMentions } from "../mentions/processUserContentMentions"

/**
 * `recursivelyMakeClineRequests` の準備フェーズ:
 *
 * 1. placeholder `api_req_started` メッセージを webview に流す
 * 2. provider 状態から表示設定 / mode を取り出す（欠損時は default）
 * 3. `processUserContentMentions` で @ mention を展開し、slash command による
 *    mode 変更指示があれば `slashCommandMode` として返す
 *
 * env_details のクリーンアップと user message の履歴登録は後段の
 * `persistUserMessageAndPlaceholder` が担当する。
 */
export interface PrepareUserContentHost {
	cwd: string
	fileContextTracker: FileContextTracker
	rooIgnoreController?: AgentIgnoreController
}

export interface PrepareUserContentProvider {
	getState(): Promise<
		| {
				showAgentIgnoredFiles?: boolean
				includeDiagnosticMessages?: boolean
				maxDiagnosticMessages?: number
				mode?: string
		  }
		| undefined
	>
	getSkillsManager(): SkillLookup | undefined
}

export interface PrepareUserContentDeps {
	host: PrepareUserContentHost
	provider?: PrepareUserContentProvider
	say: (type: "api_req_started", text: string) => Promise<unknown>
}

export interface PrepareUserContentResult {
	parsedUserContent: ContentBlockParam[]
	slashCommandMode: string | undefined
}

export async function prepareUserContentForRequest(
	deps: PrepareUserContentDeps,
	currentUserContent: ContentBlockParam[],
	apiProtocol: NonNullable<import("@openai-agent/types").ClineApiReqInfo["apiProtocol"]>,
): Promise<PrepareUserContentResult> {
	await deps.say("api_req_started", JSON.stringify({ apiProtocol }))

	const state = await deps.provider?.getState()

	const showAgentIgnoredFiles = state?.showAgentIgnoredFiles ?? false
	const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
	const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
	const currentMode = state?.mode ?? defaultModeSlug

	const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
		userContent: currentUserContent,
		cwd: deps.host.cwd,
		fileContextTracker: deps.host.fileContextTracker,
		rooIgnoreController: deps.host.rooIgnoreController,
		showAgentIgnoredFiles,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		skillsManager: deps.provider?.getSkillsManager(),
		currentMode,
	})

	return { parsedUserContent, slashCommandMode }
}
