import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import ReconnectingEventSource from "reconnecting-eventsource"

import type { McpTransport } from "./mcpConnection"
import type { ServerConfig } from "./serverConfigSchema"

/** SSE 再接続の最大待ち時間。 */
const SSE_MAX_RETRY_TIME_MS = 5000

/**
 * transport が起こしたイベントに対する「どうするか」。
 *
 * transport の作り方（mechanics）はこのモジュール、状態遷移や webview 通知（policy）は
 * 呼び出し側（McpHub）という分担にするための seam。
 */
export interface McpTransportHandlers {
	/**
	 * 接続が落ちた（`onerror` または `onclose`）。
	 * @param message エラー由来なら整形済みメッセージ。正常クローズなら undefined。
	 */
	onDisconnected(message?: string): void | Promise<void>
	/**
	 * stdio サーバの stderr 出力（1 チャンク）。
	 * @param isInfo INFO レベルのログとみなせるか（サーバは正常系も stderr に吐く）。
	 */
	onStderr(output: string, isInfo: boolean): void | Promise<void>
}

/**
 * Windows で非 .exe 実行ファイル（npx.ps1 など）を起動できるように cmd.exe で包む。
 *
 * fnm / nvm-windows / volta のようなバージョンマネージャはコマンドを PowerShell
 * スクリプトとして実装しているため、直接 spawn すると起動できない。
 * 既に cmd/cmd.exe を指定している場合は二重ラップしない。
 *
 * @param platform `process.platform` 相当。テストから任意の値を渡せるよう引数にしている。
 */
export function resolveStdioCommand(
	command: string,
	args: string[] | undefined,
	platform: NodeJS.Platform,
): { command: string; args: string[] | undefined } {
	const isWindows = platform === "win32"
	const lowered = command.toLowerCase()
	const isAlreadyWrapped = lowered === "cmd.exe" || lowered === "cmd"

	if (!isWindows || isAlreadyWrapped) {
		return { command, args }
	}

	return { command: "cmd.exe", args: ["/c", command, ...(args || [])] }
}

/** stderr の 1 チャンクが情報ログとみなせるか。 */
export function isInfoLevelStderr(output: string): boolean {
	return /INFO/i.test(output)
}

/**
 * 設定から MCP transport を作り、イベントハンドラを結線して返す。
 *
 * stdio の場合はこの中で `transport.start()` まで済ませる（stderr ストリームは
 * プロセス起動後にしか取れないが、接続処理中のエラーを拾うには `client.connect()`
 * より前に購読しておく必要があるため）。二重起動を避けるため `start` は no-op へ差し替える。
 *
 * @param config 変数展開済みのサーバ設定
 */
export async function createMcpTransport(
	name: string,
	config: ServerConfig,
	handlers: McpTransportHandlers,
	platform: NodeJS.Platform = process.platform,
): Promise<McpTransport> {
	const attachLifecycleHandlers = (transport: McpTransport, label: string) => {
		transport.onerror = async (error) => {
			console.error(`Transport error for "${name}"${label}:`, error)
			await handlers.onDisconnected(error instanceof Error ? error.message : `${error}`)
		}

		transport.onclose = async () => {
			await handlers.onDisconnected()
		}
	}

	if (config.type === "stdio") {
		const { command, args } = resolveStdioCommand(config.command, config.args, platform)

		const transport = new StdioClientTransport({
			command,
			args,
			cwd: config.cwd,
			env: {
				...getDefaultEnvironment(),
				...(config.env || {}),
			},
			stderr: "pipe",
		})

		attachLifecycleHandlers(transport, "")

		// transport.stderr is only available after the process has been started. However we can't
		// start it separately from the .connect() call because it also starts the transport. And we
		// can't place this after the connect call since we need to capture the stderr stream before
		// the connection is established, in order to capture errors during the connection process.
		// As a workaround, we start the transport ourselves, and then monkey-patch the start method
		// to no-op so that .connect() doesn't try to start it again.
		await transport.start()

		const stderrStream = transport.stderr
		if (stderrStream) {
			stderrStream.on("data", async (data: Buffer) => {
				const output = data.toString()
				await handlers.onStderr(output, isInfoLevelStderr(output))
			})
		} else {
			console.error(`No stderr stream for ${name}`)
		}

		transport.start = async () => {}

		return transport
	}

	if (config.type === "streamable-http") {
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: {
				headers: config.headers,
			},
		})

		attachLifecycleHandlers(transport, " (streamable-http)")

		return transport
	}

	if (config.type === "sse") {
		// Configure ReconnectingEventSource options
		const reconnectingEventSourceOptions = {
			max_retry_time: SSE_MAX_RETRY_TIME_MS,
			// Enable credentials if Authorization header exists
			withCredentials: config.headers?.["Authorization"] ? true : false,
			fetch: (url: string | URL, init: RequestInit) => {
				const headers = new Headers({ ...(init?.headers || {}), ...(config.headers || {}) })
				return fetch(url, { ...init, headers })
			},
		}

		global.EventSource = ReconnectingEventSource

		const transport = new SSEClientTransport(new URL(config.url), {
			requestInit: {
				headers: config.headers,
			},
			eventSourceInit: reconnectingEventSourceOptions,
		})

		attachLifecycleHandlers(transport, "")

		return transport
	}

	// Should not happen if validateServerConfig is correct
	throw new Error(`Unsupported MCP server type: ${(config as { type?: string }).type}`)
}
