import type { ClineAskResponse } from "@openai-agent/types"

import type { CheckAutoApprovalResult } from "../auto-approval"

/**
 * `checkAutoApproval` の判定結果を実際に Task に反映するモジュール。
 *
 * - "approve" / "deny" は即時に approveAsk / denyAsk を呼ぶ
 * - "respond" は返事を即時に渡す（Autopilot が質問に答える）。待ち時間は置かない
 * - "ask" は何もしない（呼び出し側の pWaitFor へ）
 *
 * どれも人の応答ではないので、繰り返しの判定の回数を残す handleWebviewAskResponse を使う
 * （userAskResponse.invariants.spec.ts）。
 */
export interface ApplyAutoApprovalDecisionHost {
	approveAsk: () => void
	denyAsk: () => void
	handleWebviewAskResponse: (askResponse: ClineAskResponse, text?: string, images?: string[]) => void
}

export function applyAutoApprovalDecision(
	host: ApplyAutoApprovalDecisionHost,
	approval: CheckAutoApprovalResult,
): void {
	if (approval.decision === "approve") {
		host.approveAsk()
		return
	}

	if (approval.decision === "deny") {
		host.denyAsk()
		return
	}

	if (approval.decision === "respond") {
		host.handleWebviewAskResponse(approval.askResponse, approval.text)
	}

	// decision === "ask" → nothing to do
}
