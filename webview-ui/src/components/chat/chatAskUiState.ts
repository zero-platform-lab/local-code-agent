import type { ClineAsk, ClineMessage, ClineSayTool } from "@openai-agent/types"

/**
 * 「直近のメッセージを見て、入力欄とボタンをどう見せるか」を決める純関数。
 *
 * 分割前は `ChatView` の中の 185 行の `useDeepCompareEffect` で、分岐ごとに
 * `setSendingDisabled` / `setClineAsk` / `setEnableButtons` / `setPrimaryButtonText` /
 * `setSecondaryButtonText` を直に呼んでいた。判断とその適用が同じ場所にあるため、
 * 「apply_patch の承認ボタンは何と出るか」を確かめるだけでも ChatView 全体を
 * mount する必要があり、実際 30 通り近い分岐に直接のテストが 1 件も無かった。
 *
 * ここは React にも i18n にも依存しない。ボタン文言は**翻訳キー**のまま返し、
 * 実際の翻訳は呼び出し側が行う。
 */

/**
 * 状態の差分。
 *
 * - キー自体が無い = **前の値を維持する**
 * - `null` = 明示的にクリアする（`undefined` にする）
 *
 * この区別が要るのは `say: api_req_retry_delayed` などが `sendingDisabled` だけを
 * 更新して他を触らない一方、`say: api_req_started` はボタンを消す必要があるため。
 */
export interface ChatAskUiPatch {
	sendingDisabled?: boolean
	clineAsk?: ClineAsk | null
	enableButtons?: boolean
	primaryButtonKey?: string | null
	secondaryButtonKey?: string | null
	/** cancel ボタンの押下状態を戻す（resume 系のみ）。 */
	resetDidClickCancel?: true
}

/**
 * 完了済みサブタスクか。親タスクを持ち、かつ会話の中に完了報告が含まれているもの。
 *
 * この規則は `ChatView` の中で 3 箇所（状態導出の呼び出し・ボタン文言の後追い更新・
 * 主ボタンのクリック処理）に同じ形で書かれていた。「再開」ではなく「新しいタスク」を
 * 見せるかどうかを決める判断なので、3 箇所でずれると表示と挙動が食い違う。
 */
export function isCompletedSubtask(input: { parentTaskId?: string; messages: ClineMessage[] }): boolean {
	return (
		!!input.parentTaskId &&
		input.messages.some((message) => message.ask === "completion_result" || message.say === "completion_result")
	)
}

export interface ChatAskUiContext {
	/** キュー中のメッセージ数。completion_result のボタン表示に影響する。 */
	queuedMessageCount: number
	/** 完了済みサブタスクか。resume_task のボタン文言が変わる。 */
	isCompletedSubtask: boolean
}

/** ツール承認の既定文言。 */
const APPROVE = { primaryButtonKey: "chat:approve.title", secondaryButtonKey: "chat:reject.title" }

/**
 * `ask: "tool"` のときのボタン文言。ツール種別と「複数まとめて聞いているか」で決まる。
 * batch 版が存在するのは編集・読み取り・一覧の 3 種類だけ。
 */
function toolButtonKeys(tool: ClineSayTool): { primaryButtonKey: string; secondaryButtonKey?: string } {
	switch (tool.tool) {
		case "editedExistingFile":
		case "appliedDiff":
		case "newFileCreated":
			return Array.isArray(tool.batchDiffs)
				? {
						primaryButtonKey: "chat:edit-batch.approve.title",
						secondaryButtonKey: "chat:edit-batch.deny.title",
					}
				: { primaryButtonKey: "chat:save.title", secondaryButtonKey: "chat:reject.title" }
		case "finishTask":
			return { primaryButtonKey: "chat:completeSubtaskAndReturn" }
		case "readFile":
			return Array.isArray(tool.batchFiles)
				? {
						primaryButtonKey: "chat:read-batch.approve.title",
						secondaryButtonKey: "chat:read-batch.deny.title",
					}
				: APPROVE
		case "listFilesTopLevel":
		case "listFilesRecursive":
			return Array.isArray(tool.batchDirs)
				? {
						primaryButtonKey: "chat:list-batch.approve.title",
						secondaryButtonKey: "chat:list-batch.deny.title",
					}
				: APPROVE
		default:
			return APPROVE
	}
}

/** `ask` メッセージ本文から tool 情報を読む。壊れた JSON は空オブジェクト扱い（既存動作）。 */
function parseTool(text: string | undefined): ClineSayTool {
	try {
		return JSON.parse(text || "{}") as ClineSayTool
	} catch {
		return {} as ClineSayTool
	}
}

function askPatch(message: ClineMessage, ctx: ChatAskUiContext): ChatAskUiPatch {
	const isPartial = message.partial === true
	const base: ChatAskUiPatch = {}

	switch (message.ask) {
		case "api_req_failed":
			return {
				...base,
				sendingDisabled: true,
				clineAsk: "api_req_failed",
				enableButtons: true,
				primaryButtonKey: "chat:retry.title",
				secondaryButtonKey: "chat:startNewTask.title",
			}
		case "mistake_limit_reached":
			return {
				...base,
				sendingDisabled: false,
				clineAsk: "mistake_limit_reached",
				enableButtons: true,
				primaryButtonKey: "chat:proceedAnyways.title",
				secondaryButtonKey: "chat:startNewTask.title",
			}
		case "followup":
			return {
				...base,
				sendingDisabled: isPartial,
				clineAsk: "followup",
				// enableButtons を false にすると、テキストエリアが有効化された瞬間に
				// フォーカスを奪ってしまう。この ask にボタンは無いので true のままにする（#1358）。
				enableButtons: true,
				primaryButtonKey: null,
				secondaryButtonKey: null,
			}
		case "tool": {
			const { primaryButtonKey, secondaryButtonKey } = toolButtonKeys(parseTool(message.text))

			return {
				...base,
				sendingDisabled: isPartial,
				clineAsk: "tool",
				enableButtons: !isPartial,
				primaryButtonKey,
				secondaryButtonKey: secondaryButtonKey ?? null,
			}
		}
		case "command":
			return {
				...base,
				sendingDisabled: isPartial,
				clineAsk: "command",
				enableButtons: !isPartial,
				primaryButtonKey: "chat:runCommand.title",
				secondaryButtonKey: "chat:reject.title",
			}
		case "command_output":
			return {
				...base,
				sendingDisabled: false,
				clineAsk: "command_output",
				enableButtons: true,
				primaryButtonKey: "chat:proceedWhileRunning.title",
				secondaryButtonKey: "chat:killCommand.title",
			}
		case "use_mcp_server":
			return {
				...base,
				sendingDisabled: isPartial,
				clineAsk: "use_mcp_server",
				enableButtons: !isPartial,
				...APPROVE,
			}
		case "completion_result":
			return {
				...base,
				sendingDisabled: isPartial,
				clineAsk: "completion_result",
				enableButtons: !isPartial,
				primaryButtonKey: "chat:startNewTask.title",
				secondaryButtonKey: null,
			}
		case "resume_task":
			return {
				...base,
				sendingDisabled: false,
				clineAsk: "resume_task",
				enableButtons: true,
				// 完了済みサブタスクは「再開」ではなく「新しいタスク」を出す。
				...(ctx.isCompletedSubtask
					? { primaryButtonKey: "chat:startNewTask.title", secondaryButtonKey: null }
					: { primaryButtonKey: "chat:resumeTask.title", secondaryButtonKey: "chat:terminate.title" }),
				resetDidClickCancel: true,
			}
		case "resume_completed_task":
			return {
				...base,
				sendingDisabled: false,
				clineAsk: "resume_completed_task",
				enableButtons: true,
				primaryButtonKey: "chat:startNewTask.title",
				secondaryButtonKey: null,
				resetDidClickCancel: true,
			}
		default:
			// 未知の ask では何も変えない。
			return base
	}
}

function sayPatch(message: ClineMessage): ChatAskUiPatch {
	switch (message.say) {
		case "api_req_retry_delayed":
		case "api_req_rate_limit_wait":
			// 送信だけ止める。ボタンの状態は ask のものを残す。
			return { sendingDisabled: true }
		case "api_req_started":
			// 新しい API リクエストが始まったらボタンを消す。タスク継続時にボタンが
			// 残り続ける問題の対策。
			//
			// NOTE: ここで selectedImages は消さないこと。このハンドラは API 呼び出しの
			// たびに走るので、進行中にユーザーが貼った画像まで消えてしまう。画像は
			// ユーザー操作側（送信・ボタン押下）で消している。
			return {
				sendingDisabled: true,
				clineAsk: null,
				enableButtons: false,
				primaryButtonKey: null,
				secondaryButtonKey: null,
			}
		default:
			// ask への応答待ちの最中に say が挟まることがあるので、状態は触らない。
			return {}
	}
}

/**
 * 直近のメッセージから UI 状態の差分を求める。
 * メッセージが無い、または関係ない種類なら空の差分（＝現状維持）。
 */
export function deriveChatAskUiPatch(message: ClineMessage | undefined, ctx: ChatAskUiContext): ChatAskUiPatch {
	if (!message) {
		return {}
	}

	if (message.type === "ask") {
		return askPatch(message, ctx)
	}

	if (message.type === "say") {
		return sayPatch(message)
	}

	return {}
}
