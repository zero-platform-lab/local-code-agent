import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isAutopilotMode,
	isNonBlockingAsk,
} from "@openai-agent/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import { getCommandDecision } from "./commands"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"
	| "autonomyMode" // Autopilot answers every blocking ask instead of asking.

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| { decision: "respond"; askResponse: ClineAskResponse; text: string }

/** Autopilot が、候補の無い質問に返す答え。人は画面の前にいない前提で進めさせる。 */
export const AUTOPILOT_NO_SUGGESTION_ANSWER =
	"The user is not available to answer (Autopilot mode). Choose the most reasonable option yourself and continue."

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	if (!state) {
		return { decision: "ask" }
	}

	if (isAutopilotMode(state.autonomyMode)) {
		return checkAutopilot({ state, ask, text, isProtected })
	}

	// Autopilot 以外では、質問は必ず人に聞く（下の分岐のどれにも当たらず "ask" で終わる）。
	if (!state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (_error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files - skills must be explicitly installed/defined by the user.
		// Auto-approval is intentional to provide a seamless experience when loading task instructions.
		if (tool.tool === "skill") {
			return { decision: "approve" }
		}

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

/** 質問の最初の候補。解釈できなければ undefined。 */
function firstSuggestion(text: string | undefined): string | undefined {
	try {
		return (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]?.answer
	} catch (_error) {
		return undefined
	}
}

/**
 * Autopilot の判定。止める ask には人を待たずに答える。人に聞く（"ask"）を返すのは、
 * 止める操作ではない ask（完了・再開・実行中のコマンドへの入力）だけである。
 *
 * 許さないものは拒否する。拒否はツールの結果としてモデルへ返り、モデルは別の方法で続ける。
 */
function checkAutopilot({
	state,
	ask,
	text,
	isProtected,
}: {
	state: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): CheckAutoApprovalResult {
	switch (ask) {
		case "followup":
			return {
				decision: "respond",
				askResponse: "messageResponse",
				text: firstSuggestion(text) ?? AUTOPILOT_NO_SUGGESTION_ANSWER,
			}

		// 再試行・続行のボタンを押したのと同じ。連続ミスとリクエスト数・料金の上限では止めない。
		case "api_req_failed":
		case "mistake_limit_reached":
		case "auto_approval_max_req_reached":
		case "use_mcp_server":
			return { decision: "approve" }

		case "command":
			// 拒否リストに当たるものだけ拒否し、許可リストに無いものも実行する。
			return text &&
				getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || []) !== "auto_deny"
				? { decision: "approve" }
				: { decision: "deny" }

		case "tool":
			return checkAutopilotTool(state, text, isProtected)

		default:
			return { decision: "ask" }
	}
}

/** Autopilot でのファイル操作。ワークスペースの外と保護対象は、個別の設定が on のときだけ許す。 */
function checkAutopilotTool(
	state: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>,
	text: string | undefined,
	isProtected: boolean | undefined,
): CheckAutoApprovalResult {
	let tool: ClineSayTool | undefined
	try {
		tool = text ? JSON.parse(text) : undefined
	} catch (_error) {
		tool = undefined
	}

	// 何のツールか分からないものは実行しない。
	if (!tool) {
		return { decision: "deny" }
	}

	const isOutsideWorkspace = !!tool.isOutsideWorkspace

	if (isReadOnlyToolAction(tool)) {
		return !isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true
			? { decision: "approve" }
			: { decision: "deny" }
	}

	if (isWriteToolAction(tool)) {
		return (!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
			(!isProtected || state.alwaysAllowWriteProtected === true)
			? { decision: "approve" }
			: { decision: "deny" }
	}

	// どちらにも分類されないツール（webFetch・サブタスクなど）は、有効にしてあるので実行する。
	return { decision: "approve" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
