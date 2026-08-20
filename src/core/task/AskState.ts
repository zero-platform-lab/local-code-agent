import type { ClineAskResponse } from "../../shared/WebviewMessage"
import type { ClineMessage } from "@openai-agent/types"

/**
 * Task の ask 系状態（webview に投げる ask とその応答）を凝集した collaborator。
 *
 * 元は Task class に 8 field ばら撒きだったのを 1 object にまとめた:
 * - askResponse / askResponseText / askResponseImages: webview からの応答（一時保持）
 * - lastMessageTs: 直近 ask/say の timestamp（応答が対応する ask に紐付くか判定に使う）
 * - autoApprovalTimeoutRef: 自動承認の setTimeout ハンドル
 * - idleAsk / resumableAsk / interactiveAsk: 直近 ask の status 遷移追跡（TaskStatus 算出に使用）
 *
 * ask/response の reset パターンが元コードで 3 箇所に重複していたので `resetResponse()` に集約。
 * idle/resumable/interactive の clear も 2 箇所重複していたので `clearAsks()` に集約。
 */
export class AskState {
	askResponse?: ClineAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	lastMessageTs?: number
	autoApprovalTimeoutRef?: NodeJS.Timeout

	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	/** webview からの応答 3 field をクリア。runAskFlow の resetAskResponse・awaitAskResponseAndFinalize で使用。 */
	resetResponse(): void {
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
	}

	/** ask status 3 field をクリア。resumeAfterDelegation・awaitAskResponseAndFinalize で使用。 */
	clearAsks(): void {
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
	}

	/** auto-approval timer をキャンセルする（発火前に取り消す用途）。 */
	cancelAutoApprovalTimeout(): void {
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
	}

	/** taskAsk getter が返す「直近 ask」の優先順位: idle > resumable > interactive。 */
	get currentAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}
}
