import {
	type ClineMessage,
	type ClineSay,
	type ContextCondense,
	type ContextTruncation,
	type ToolProgressStatus,
} from "@openai-agent/types"

import type { AskState } from "./AskState"

/**
 * UI メッセージ（say）の追加・更新に必要な操作。
 *
 * `lastMessageTs` は AskState に移されたので、host は askState 経由で書く。
 */
export interface SayStateHost {
	abort: boolean
	taskId: string
	instanceId: string | number
	messageStore: { clineMessages: ClineMessage[] }
	askState: AskState
	addToClineMessages: (message: ClineMessage) => Promise<unknown>
	updateClineMessage: (message: ClineMessage) => void | Promise<unknown>
	saveClineMessages: () => Promise<unknown>
}

export interface SayDeps {
	host: SayStateHost
}

export interface SayOptions {
	isNonInteractive?: boolean
}

/**
 * UI にメッセージを1件出す。
 *
 * `partial` の値で3つの経路に分かれる:
 *   - `true`  … 直前が同種の partial なら更新、そうでなければ partial として新規追加
 *   - `false` … 直前の partial を完成版で置き換える（保存してから更新通知）
 *   - 未指定  … 通常の新規追加
 *
 * `isNonInteractive` なメッセージは `lastMessageTs` を動かさない。非同期に生成されうるため、
 * 保留中の ask を横取りしないようにする。
 */
export async function say(
	deps: SayDeps,
	type: ClineSay,
	text?: string,
	images?: string[],
	partial?: boolean,
	checkpoint?: Record<string, unknown>,
	progressStatus?: ToolProgressStatus,
	options: SayOptions = {},
	contextCondense?: ContextCondense,
	contextTruncation?: ContextTruncation,
): Promise<undefined> {
	if (deps.host.abort) {
		throw new Error(`[Agent#say] task ${deps.host.taskId}.${deps.host.instanceId} aborted`)
	}

	if (partial !== undefined) {
		const lastMessage = deps.host.messageStore.clineMessages.at(-1)

		const isUpdatingPreviousPartial =
			lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

		if (partial) {
			if (isUpdatingPreviousPartial) {
				// Existing partial message, so update it.
				lastMessage.text = text
				lastMessage.images = images
				lastMessage.partial = partial
				lastMessage.progressStatus = progressStatus
				deps.host.updateClineMessage(lastMessage)
			} else {
				// This is a new partial message, so add it with partial state.
				const sayTs = Date.now()

				if (!options.isNonInteractive) {
					deps.host.askState.lastMessageTs = sayTs
				}

				await deps.host.addToClineMessages({
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					partial,
					contextCondense,
					contextTruncation,
				})
			}
		} else {
			// New now have a complete version of a previously partial message.
			// This is the complete version of a previously partial
			// message, so replace the partial with the complete version.
			if (isUpdatingPreviousPartial) {
				if (!options.isNonInteractive) {
					deps.host.askState.lastMessageTs = lastMessage.ts
				}

				lastMessage.text = text
				lastMessage.images = images
				lastMessage.partial = false
				lastMessage.progressStatus = progressStatus

				// Instead of streaming partialMessage events, we do a save
				// and post like normal to persist to disk.
				await deps.host.saveClineMessages()

				// More performant than an entire `postStateToWebview`.
				deps.host.updateClineMessage(lastMessage)
			} else {
				// This is a new and complete message, so add it like normal.
				const sayTs = Date.now()

				if (!options.isNonInteractive) {
					deps.host.askState.lastMessageTs = sayTs
				}

				await deps.host.addToClineMessages({
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					contextCondense,
					contextTruncation,
				})
			}
		}
	} else {
		// This is a new non-partial message, so add it like normal.
		const sayTs = Date.now()

		// A "non-interactive" message is a message is one that the user
		// does not need to respond to. We don't want these message types
		// to trigger an update to `lastMessageTs` since they can be created
		// asynchronously and could interrupt a pending ask.
		if (!options.isNonInteractive) {
			deps.host.askState.lastMessageTs = sayTs
		}

		await deps.host.addToClineMessages({
			ts: sayTs,
			type: "say",
			say: type,
			text,
			images,
			checkpoint,
			contextCondense,
			contextTruncation,
		})
	}
}
