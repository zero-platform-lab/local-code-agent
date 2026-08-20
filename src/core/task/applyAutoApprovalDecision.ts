import type { ClineAskResponse } from "@openai-agent/types"

import type { CheckAutoApprovalResult } from "../auto-approval"
import type { AskState } from "./AskState"

/**
 * `checkAutoApproval` の判定結果を実際に Task に反映するモジュール。
 *
 * - "approve" / "deny" は即時に approveAsk / denyAsk を呼ぶ
 * - "timeout" は auto-approval Timeout を仕込み、`askState.autoApprovalTimeoutRef`
 *   にセットする（ユーザー操作があれば呼び出し側で clear 可能にするため返り値も返す）
 * - "ask" は何もしない（呼び出し側の pWaitFor へ）
 */
export interface ApplyAutoApprovalDecisionHost {
	approveAsk: () => void
	denyAsk: () => void
	askState: AskState
	handleWebviewAskResponse: (askResponse: ClineAskResponse, text?: string, images?: string[]) => void
}

export function applyAutoApprovalDecision(
	host: ApplyAutoApprovalDecisionHost,
	approval: CheckAutoApprovalResult,
): NodeJS.Timeout | undefined {
	if (approval.decision === "approve") {
		host.approveAsk()
		return undefined
	}

	if (approval.decision === "deny") {
		host.denyAsk()
		return undefined
	}

	if (approval.decision === "timeout") {
		// Store the auto-approval timeout so it can be cancelled if user interacts
		const timeout = setTimeout(() => {
			const { askResponse, text, images } = approval.fn()
			host.handleWebviewAskResponse(askResponse, text, images)
			host.askState.autoApprovalTimeoutRef = undefined
		}, approval.timeout)
		host.askState.autoApprovalTimeoutRef = timeout
		return timeout
	}

	// decision === "ask" → nothing to do
	return undefined
}
