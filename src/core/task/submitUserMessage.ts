import { AgentEventName, type ProviderSettings } from "@openai-agent/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

/**
 * ユーザー入力を送信するときに必要な操作。
 *
 * Task を state host として渡し、`emit` / `updateApiConfiguration` /
 * `handleWebviewAskResponse` は host 経由で直接呼ぶ。provider 参照のみ
 * WeakRef の解決を callback で受ける。
 */
export interface SubmitUserMessageStateHost {
	taskId: string
	emit: (event: typeof AgentEventName.TaskUserMessage, taskId: string) => void
	updateApiConfiguration: (config: ProviderSettings) => void
	handleWebviewAskResponse: (response: ClineAskResponse, text?: string, images?: string[]) => void
	providerRef: WeakRef<SubmitUserMessageProvider>
}

export interface SubmitUserMessageDeps {
	host: SubmitUserMessageStateHost
}

/**
 * このハンドラが provider に要求する narrow interface。
 */
export interface SubmitUserMessageProvider {
	setMode(mode: string): Promise<void>
	setProviderProfile(profile: string): Promise<void>
	getState(): Promise<{ apiConfiguration?: ProviderSettings } | undefined>
}

/**
 * webview の入力欄から送られたユーザーメッセージを受け取り、必要ならモード / プロバイダを
 * 切り替えたうえで、現在の Task の ask ハンドラへ「messageResponse」として渡す。
 *
 * webview を経由せず直接 `handleWebviewAskResponse` を呼ぶのは意図的。webview の
 * メッセージ状態がハイドレート前だと「新規タスクリクエスト」と解釈されてしまう
 * レースを避けるため。
 */
export async function submitUserMessage(
	deps: SubmitUserMessageDeps,
	text: string,
	images?: string[],
	mode?: string,
	providerProfile?: string,
): Promise<void> {
	try {
		text = (text ?? "").trim()
		images = images ?? []

		if (text.length === 0 && images.length === 0) {
			return
		}

		const provider = deps.host.providerRef.deref()

		if (!provider) {
			console.error("[Task#submitUserMessage] Provider reference lost")
			return
		}

		if (mode) {
			await provider.setMode(mode)
		}

		if (providerProfile) {
			await provider.setProviderProfile(providerProfile)

			// Update this task's API configuration to match the new profile
			// This ensures the parser state is synchronized with the selected model
			const newState = await provider.getState()
			if (newState?.apiConfiguration) {
				deps.host.updateApiConfiguration(newState.apiConfiguration)
			}
		}

		deps.host.emit(AgentEventName.TaskUserMessage, deps.host.taskId)

		// Handle the message directly instead of routing through the webview.
		// This avoids a race condition where the webview's message state hasn't
		// hydrated yet, causing it to interpret the message as a new task request.
		deps.host.handleWebviewAskResponse("messageResponse", text, images)
	} catch (error) {
		console.error("[Task#submitUserMessage] Failed to submit user message:", error)
	}
}
