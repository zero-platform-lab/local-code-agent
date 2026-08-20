import * as vscode from "vscode"

import {
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type ExtensionMessage,
} from "@openai-agent/types"

import { supportPrompt } from "../../shared/support-prompt"
import { OrganizationAllowListViolationError } from "../../utils/errors"

/** サポートプロンプト経由のアクション実行に必要な provider の最小表面。 */
export interface SupportPromptActionTarget {
	getState(): Promise<{ customSupportPrompts?: Record<string, any> }>
	postMessageToWebview(message: ExtensionMessage): Promise<void>
	createTask(prompt: string): Promise<unknown>
}

/**
 * コードアクション（explain/fix/improve/addToContext/newTask）を実行する。
 * ClineProvider.handleCodeAction の本体（getInstance/null チェックは呼び出し側に残す）。
 */
export async function runCodeAction(
	target: SupportPromptActionTarget,
	command: CodeActionId,
	promptType: CodeActionName,
	params: Record<string, string | any[]>,
): Promise<void> {
	const { customSupportPrompts } = await target.getState()

	// TODO: Improve type safety for promptType.
	const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

	if (command === "addToContext") {
		await target.postMessageToWebview({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: `${prompt}\n\n`,
		})
		await target.postMessageToWebview({ type: "action", action: "focusInput" })
		return
	}

	await target.createTask(prompt)
}

/**
 * ターミナルアクションを実行する。ClineProvider.handleTerminalAction の本体。
 * allowlist 違反時はエラーダイアログを出しつつ再スロー（呼び出し規約を維持）。
 */
export async function runTerminalAction(
	target: SupportPromptActionTarget,
	command: TerminalActionId,
	promptType: TerminalActionPromptType,
	params: Record<string, string | any[]>,
): Promise<void> {
	const { customSupportPrompts } = await target.getState()
	const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

	if (command === "terminalAddToContext") {
		await target.postMessageToWebview({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: `${prompt}\n\n`,
		})
		await target.postMessageToWebview({ type: "action", action: "focusInput" })
		return
	}

	try {
		await target.createTask(prompt)
	} catch (error) {
		if (error instanceof OrganizationAllowListViolationError) {
			// Errors from terminal commands seem to get swallowed / ignored.
			vscode.window.showErrorMessage(error.message)
		}

		throw error
	}
}
