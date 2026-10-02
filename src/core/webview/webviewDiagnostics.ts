import type { ExtensionMessage, ExtensionState } from "@openai-agent/types"

/**
 * 白い画面の調査に使う、Webview まわりのログ。
 *
 * 白くなった瞬間の手がかりは、これまで Webview の開発者ツールにしか出ていなかった。
 * 出力パネル（拡張のログ）に次の 3 つを残し、ログを貼ってもらうだけで切り分けられるようにする。
 *
 * - Webview のエラー（webview-ui の `forwardErrorsToExtension` が送る）
 * - Webview の起動・表示の切り替え・破棄（`initializeWebview` と `webviewDidLaunch`）
 * - 拡張から Webview へ送る状態の大きさ（`postStateWithDiagnostics`）
 */

/** これを超える状態を送ったら警告する。会話の全体を毎回送っていて重い、という仮説を数字で確かめる。 */
export const STATE_POST_WARN_BYTES = 5 * 1024 * 1024

/** Webview から届いた診断の 1 行。 */
export function formatWebviewDiagnostic(text: string | undefined): string {
	return `[Webview] ${text ?? "(empty diagnostic)"}`
}

/** Webview が起動した（または読み込み直された）ことを示す 1 行。 */
export function describeWebviewLaunch(currentTaskId: string | undefined, now: Date = new Date()): string {
	const task = currentTaskId ? `task ${currentTaskId} is running` : "no task"
	return `[Webview] launched at ${now.toISOString()} (${task})`
}

/**
 * 送る状態の大きさを 1 行にする。
 *
 * **計測のために JSON.stringify を 1 回余分に実行する。** postMessage も内部で直列化するので、
 * 状態を送るたびに直列化が 2 回になる。白い画面の原因が分かったら、この計測は外してよい。
 */
export function describeStatePost(
	state: Partial<Pick<ExtensionState, "clineMessages">>,
	warnBytes: number = STATE_POST_WARN_BYTES,
): string {
	const messages = state.clineMessages?.length ?? "omitted"

	let bytes: number
	try {
		bytes = Buffer.byteLength(JSON.stringify(state), "utf8")
	} catch (error) {
		// 直列化できない状態は postMessage でも送れない。それ自体が白い画面の原因になりうる。
		return `[Webview] WARN state post: failed to measure (clineMessages=${messages}): ${
			error instanceof Error ? error.message : String(error)
		}`
	}

	const line = `state post: ${bytes} bytes, clineMessages=${messages}`
	return bytes > warnBytes ? `[Webview] WARN ${line} (over ${warnBytes} bytes)` : `[Webview] ${line}`
}

export interface StatePostHost {
	log(message: string): void
	postMessageToWebview(message: ExtensionMessage): Promise<unknown>
}

/**
 * 状態を Webview へ送る、唯一の経路。送る前に大きさをログへ残す。
 *
 * `{ type: "state" }` を送る箇所はここだけに固定している
 * （`__tests__/webviewDiagnostics.invariants.spec.ts`）。
 */
export function postStateWithDiagnostics(
	host: StatePostHost,
	state: ExtensionMessage["state"],
	warnBytes: number = STATE_POST_WARN_BYTES,
): Promise<unknown> {
	host.log(describeStatePost(state ?? {}, warnBytes))
	return host.postMessageToWebview({ type: "state", state })
}
