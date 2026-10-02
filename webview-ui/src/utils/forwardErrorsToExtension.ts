import { vscode } from "./vscode"

/**
 * Webview のエラーを拡張のログ（出力パネル）へ送る。
 *
 * 白い画面の調査用である。これまでエラーは Webview の開発者ツールにしか出ず、
 * 利用者に開発者ツールを操作してもらわないと読めなかった。受け取る側は
 * `src/core/webview/webviewDiagnostics.ts` の `formatWebviewDiagnostic`。
 */

/** 1 件に載せる長さの上限。スタックが長すぎると出力パネルが読めなくなる。 */
export const DIAGNOSTIC_MAX_LENGTH = 4000

/** エラーを 1 行の文にする。Error ならスタックを、そうでなければ文字列にしたものを使う。 */
export function describeErrorForExtension(value: unknown, maxLength: number = DIAGNOSTIC_MAX_LENGTH): string {
	const text = value instanceof Error ? (value.stack ?? value.message) : String(value)
	return text.length > maxLength ? `${text.slice(0, maxLength)}… (truncated)` : text
}

/** 診断を 1 件、拡張へ送る。 */
export function reportWebviewDiagnostic(text: string): void {
	vscode.postMessage({ type: "webviewDiagnostic", text })
}

/**
 * `error` と `unhandledrejection` を拡張へ転送する。戻り値で登録を外す。
 */
export function forwardErrorsToExtension(target: Window = window): () => void {
	const onError = (event: ErrorEvent) => {
		reportWebviewDiagnostic(`error: ${describeErrorForExtension(event.error ?? event.message)}`)
	}
	const onRejection = (event: PromiseRejectionEvent) => {
		reportWebviewDiagnostic(`unhandled rejection: ${describeErrorForExtension(event.reason)}`)
	}

	target.addEventListener("error", onError)
	target.addEventListener("unhandledrejection", onRejection)

	return () => {
		target.removeEventListener("error", onError)
		target.removeEventListener("unhandledrejection", onRejection)
	}
}
