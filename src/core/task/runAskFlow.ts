import type { ClineAsk, ClineAskResponse, ClineMessage, ToolProgressStatus } from "@openai-agent/types"

import { checkAutoApproval } from "../auto-approval"

import { applyAutoApprovalDecision, type ApplyAutoApprovalDecisionHost } from "./applyAutoApprovalDecision"
import { awaitAskResponseAndFinalize, type AwaitAskResponseAndFinalizeHost } from "./awaitAskResponseAndFinalize"
import { drainQueuedMessageForAsk, type DrainQueuedMessageForAskHost } from "./drainQueuedMessageForAsk"
import { scheduleAskStatusMutation, type ScheduleAskStatusMutationHost } from "./scheduleAskStatusMutation"
import { upsertAskMessage } from "./upsertAskMessage"
import type { AskState } from "./AskState"

/**
 * `Task.ask()` の 4 パート合成フロー本体:
 *
 * 1. abort ガード（呼び出し側の Task から throw を渡してもらう）
 * 2. `upsertAskMessage` で clineMessages に追加/更新
 * 3. `checkAutoApproval` + `applyAutoApprovalDecision`（timeout も含む）
 * 4. status mutable なら `scheduleAskStatusMutation`、そうでなく queue drain 対象なら
 *    `drainQueuedMessageForAsk`
 * 5. `awaitAskResponseAndFinalize` で pWaitFor + cleanup + return
 */
export type RunAskFlowHost = ApplyAutoApprovalDecisionHost &
	ScheduleAskStatusMutationHost &
	AwaitAskResponseAndFinalizeHost &
	DrainQueuedMessageForAskHost & {
		abort: boolean
		taskId: string
		instanceId: string | number
		messageStore: { clineMessages: ClineMessage[] }
		askState: AskState
		providerRef: WeakRef<{
			getState(): Promise<never>
			postMessageToWebview: (message: { type: "interactionRequired" }) => void
		}>
		addToClineMessages: (message: ClineMessage) => Promise<unknown>
		saveClineMessages: () => Promise<unknown>
		updateClineMessage: (message: ClineMessage) => unknown
		findMessageByTimestamp: (ts: number) => ClineMessage | undefined
	}

export interface RunAskFlowDeps {
	host: RunAskFlowHost
}

export async function runAskFlow(
	deps: RunAskFlowDeps,
	type: ClineAsk,
	text: string | undefined,
	partial: boolean | undefined,
	progressStatus: ToolProgressStatus | undefined,
	isProtected: boolean | undefined,
): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
	const { host } = deps

	// If this Cline instance was aborted by the provider, then the only
	// thing keeping us alive is a promise still running in the background,
	// in which case we don't want to send its result to the webview as it
	// is attached to a new instance of Cline now.
	if (host.abort) {
		throw new Error(`[Agent#ask] task ${host.taskId}.${host.instanceId} aborted`)
	}

	const { askTs } = await upsertAskMessage(
		{
			clineMessages: host.messageStore.clineMessages,
			setLastMessageTs: (ts) => {
				host.askState.lastMessageTs = ts
			},
			resetAskResponse: () => host.askState.resetResponse(),
			addToClineMessages: host.addToClineMessages.bind(host),
			saveClineMessages: host.saveClineMessages.bind(host),
			updateClineMessage: host.updateClineMessage.bind(host),
		},
		{ type, text, partial, progressStatus, isProtected },
	)

	const timeouts: NodeJS.Timeout[] = []

	// Automatically approve if the ask according to the user's settings.
	const provider = host.providerRef.deref()
	const state = provider ? await provider.getState() : undefined
	const approval = await checkAutoApproval({ state, ask: type, text, isProtected })

	const autoApprovalTimeout = applyAutoApprovalDecision(host, approval)
	if (autoApprovalTimeout) {
		timeouts.push(autoApprovalTimeout)
	}

	// The state is mutable if the message is complete and the task will
	// block (via the `pWaitFor`).
	const isBlocking = !(host.askState.askResponse !== undefined || host.askState.lastMessageTs !== askTs)
	const isMessageQueued = !host.messageQueueService.isEmpty()
	// Keep queued user messages intact during command_output asks. Those asks
	// are terminal flow-control, not conversational turns.
	const shouldDrainQueuedMessageForAsk = type !== "command_output"
	const isStatusMutable = !partial && isBlocking && !isMessageQueued && approval.decision === "ask"

	if (isStatusMutable) {
		const timeout = scheduleAskStatusMutation(
			{
				findMessageByTimestamp: host.findMessageByTimestamp.bind(host),
				setInteractiveAsk: (m) => {
					host.askState.interactiveAsk = m
				},
				setResumableAsk: (m) => {
					host.askState.resumableAsk = m
				},
				setIdleAsk: (m) => {
					host.askState.idleAsk = m
				},
				emit: (event, taskId) => host.emit(event, taskId),
				taskId: host.taskId,
				postMessageToWebview: (message) => {
					provider?.postMessageToWebview(message)
				},
			},
			type,
			askTs,
		)
		if (timeout) {
			timeouts.push(timeout)
		}
	} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
		drainQueuedMessageForAsk(host, type)
	}

	return awaitAskResponseAndFinalize(host, { askTs, timeouts, type, shouldDrainQueuedMessageForAsk })
}
