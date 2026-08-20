/**
 * Network Proxy Configuration Module
 *
 * Provides proxy configuration for all outbound HTTP/HTTPS requests from the Agent extension.
 * When running in debug mode (F5), a proxy can be enabled for outbound traffic.
 * Optionally, TLS certificate verification can be disabled (debug only) to allow
 * MITM proxy inspection.
 *
 * Uses global-agent to globally route all HTTP/HTTPS traffic through the proxy,
 * which works with axios, fetch, and most SDKs that use native Node.js http/https.
 */

import * as vscode from "vscode"
import { Package } from "../shared/package"

/**
 * Proxy configuration state
 */
export interface ProxyConfig {
	/** Whether the debug proxy is enabled */
	enabled: boolean
	/** The proxy server URL (e.g., http://127.0.0.1:8888) */
	serverUrl: string
	/** Accept self-signed/insecure TLS certificates from the proxy (required for MITM) */
	tlsInsecure: boolean
	/** Whether running in debug/development mode */
	isDebugMode: boolean
}

let extensionContext: vscode.ExtensionContext | null = null
let proxyInitialized = false
let undiciProxyInitialized = false
let fetchPatched = false
let originalFetch: typeof fetch | undefined
let outputChannel: vscode.OutputChannel | null = null

// loggingEnabled は log() のガード（未初期化時は return）が読んでいたが、そのガードは
// debug 入口ゲートより後でしか log が呼ばれず到達不能だったため除去した。読み手が
// 無くなったのでフラグ自体も持たない（consoleLoggingEnabled は出力先の分岐で今も使う）。
let consoleLoggingEnabled = false

let tlsVerificationOverridden = false
let originalNodeTlsRejectUnauthorized: string | undefined

/** 例外オブジェクトから人間可読なメッセージを取り出す（Error 以外は文字列化）。 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// 呼び出し元は常に getProxyConfig 由来の非空 serverUrl（既定値付き）を渡す。
function redactProxyUrl(proxyUrl: string): string {
	try {
		const url = new URL(proxyUrl)
		url.username = ""
		url.password = ""
		return url.toString()
	} catch {
		// Fallback for invalid URLs: redact basic auth if present.
		return proxyUrl.replace(/\/\/[^@/]+@/g, "//REDACTED@")
	}
}

function restoreGlobalFetchPatch(): void {
	if (!fetchPatched) {
		return
	}

	if (originalFetch) {
		globalThis.fetch = originalFetch
	}

	fetchPatched = false
	originalFetch = undefined
}

function restoreTlsVerificationOverride(): void {
	if (!tlsVerificationOverridden) {
		return
	}

	if (typeof originalNodeTlsRejectUnauthorized === "string") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTlsRejectUnauthorized
	} else {
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
	}

	tlsVerificationOverridden = false
	originalNodeTlsRejectUnauthorized = undefined
}

function applyTlsVerificationOverride(config: ProxyConfig): void {
	// 呼び出し元（initializeNetworkProxy / 設定変更リスナ）はいずれも debug モードかつ enabled の
	// ときだけこの関数を呼ぶ。TLS 検証の無効化そのものは tlsInsecure フラグでのみ制御する。
	if (!config.tlsInsecure) {
		restoreTlsVerificationOverride()
		return
	}

	if (!tlsVerificationOverridden) {
		originalNodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED
	}

	// CodeQL: debug-only opt-in for MITM debugging.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" // lgtm[js/disabling-certificate-validation]
	tlsVerificationOverridden = true
}

/**
 * Initialize the network proxy module with the extension context.
 * Must be called early in extension activation before any network requests.
 *
 * @param context The VS Code extension context
 * @param channel Optional output channel for logging
 */
export async function initializeNetworkProxy(
	context: vscode.ExtensionContext,
	channel?: vscode.OutputChannel,
): Promise<void> {
	extensionContext = context

	// extensionMode is immutable for the process lifetime - exit early if not in debug mode.
	// This avoids any overhead (listeners, logging, etc.) in production.
	const isDebugMode = context.extensionMode === vscode.ExtensionMode.Development
	if (!isDebugMode) {
		return
	}

	outputChannel = channel ?? null
	consoleLoggingEnabled = !outputChannel

	const config = getProxyConfig()

	log(`Initializing network proxy module...`)
	log(
		`Proxy config: enabled=${config.enabled}, serverUrl=${redactProxyUrl(config.serverUrl)}, tlsInsecure=${config.tlsInsecure}`,
	)

	// Listen for configuration changes to allow toggling proxy during a debug session.
	// Guard for test environments where onDidChangeConfiguration may not be mocked.
	if (typeof vscode.workspace.onDidChangeConfiguration === "function") {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration(`${Package.name}.debugProxy.enabled`) ||
					e.affectsConfiguration(`${Package.name}.debugProxy.serverUrl`) ||
					e.affectsConfiguration(`${Package.name}.debugProxy.tlsInsecure`)
				) {
					const newConfig = getProxyConfig()

					if (newConfig.enabled) {
						applyTlsVerificationOverride(newConfig)
						configureGlobalProxy(newConfig)
						configureUndiciProxy(newConfig)
					} else {
						// Proxy disabled - but we can't easily un-bootstrap global-agent or reset undici dispatcher safely.
						// We *can* restore any global fetch patch immediately.
						restoreGlobalFetchPatch()
						restoreTlsVerificationOverride()
						log("Debug proxy disabled. Restart VS Code to fully disable proxy routing.")
					}
				}
			}),
		)
	}

	// Ensure we restore any overrides when the extension unloads.
	context.subscriptions.push({
		dispose: () => {
			restoreGlobalFetchPatch()
			restoreTlsVerificationOverride()
		},
	})

	if (config.enabled) {
		applyTlsVerificationOverride(config)
		await configureGlobalProxy(config)
		await configureUndiciProxy(config)
	} else {
		log(`Debug proxy not enabled.`)
	}
}

/**
 * Get the current proxy configuration based on VS Code settings and extension mode.
 */
export function getProxyConfig(): ProxyConfig {
	const defaultServerUrl = "http://127.0.0.1:8888"

	if (!extensionContext) {
		// Fallback if called before initialization
		return {
			enabled: false,
			serverUrl: defaultServerUrl,
			tlsInsecure: false,
			isDebugMode: false,
		}
	}

	const config = vscode.workspace.getConfiguration(Package.name)
	const enabled = Boolean(config.get<unknown>("debugProxy.enabled"))
	const rawServerUrl = config.get<unknown>("debugProxy.serverUrl")
	const serverUrl = typeof rawServerUrl === "string" && rawServerUrl.trim() ? rawServerUrl.trim() : defaultServerUrl
	const tlsInsecure = Boolean(config.get<unknown>("debugProxy.tlsInsecure"))

	// Debug mode only.
	const isDebugMode = extensionContext.extensionMode === vscode.ExtensionMode.Development

	return {
		enabled,
		serverUrl,
		tlsInsecure,
		isDebugMode,
	}
}

/**
 * Configure global-agent to route all HTTP/HTTPS traffic through the proxy.
 */
async function configureGlobalProxy(config: ProxyConfig): Promise<void> {
	if (proxyInitialized) {
		// global-agent can only be bootstrapped once
		// Update environment variables for any new connections
		log(`Proxy already initialized, updating env vars only`)
		updateProxyEnvVars(config)
		return
	}

	// Set up environment variables before bootstrapping
	log(`Setting proxy environment variables before bootstrap (values redacted)...`)
	updateProxyEnvVars(config)

	let bootstrap: (() => void) | undefined
	try {
		const mod = (await import("global-agent")) as typeof import("global-agent")
		bootstrap = mod.bootstrap
	} catch (error) {
		log(`Failed to load global-agent (proxy support is only available in debug/dev builds): ${errorMessage(error)}`)
		return
	}

	// Bootstrap global-agent to intercept all HTTP/HTTPS requests
	log(`Calling global-agent bootstrap()...`)
	try {
		bootstrap()
		proxyInitialized = true
		log(`global-agent bootstrap() completed successfully`)
	} catch (error) {
		log(`global-agent bootstrap() FAILED: ${errorMessage(error)}`)
		return
	}

	log(`Network proxy configured: ${redactProxyUrl(config.serverUrl)}`)
}

/**
 * Configure undici's global dispatcher so Node's built-in `fetch()` and any undici-based
 * clients route through the proxy.
 */
async function configureUndiciProxy(config: ProxyConfig): Promise<void> {
	// 呼び出し元は常に enabled かつ serverUrl 設定済みで呼ぶ（getProxyConfig は serverUrl に
	// 既定値を必ず入れる）。ここでは初期化済みかどうかだけを見る。
	if (undiciProxyInitialized) {
		log(`undici global dispatcher already configured; restart VS Code to change proxy safely`)
		return
	}

	try {
		const {
			ProxyAgent,
			setGlobalDispatcher,
			fetch: undiciFetch,
		} = (await import("undici")) as typeof import("undici")

		const proxyAgent = new ProxyAgent({
			uri: config.serverUrl,
			// If the user enabled TLS insecure mode (debug only), apply it to undici.
			requestTls: config.tlsInsecure
				? ({ rejectUnauthorized: false } satisfies import("tls").ConnectionOptions) // lgtm[js/disabling-certificate-validation]
				: undefined,
			proxyTls: config.tlsInsecure
				? ({ rejectUnauthorized: false } satisfies import("tls").ConnectionOptions) // lgtm[js/disabling-certificate-validation]
				: undefined,
		})
		setGlobalDispatcher(proxyAgent)
		undiciProxyInitialized = true
		log(`undici global dispatcher configured for proxy: ${redactProxyUrl(config.serverUrl)}`)

		// Node's built-in `fetch()` (Node 18+) is powered by an internal undici copy.
		// Setting a dispatcher on our `undici` dependency does NOT affect that internal fetch.
		// To ensure Agent's `fetch()` calls are proxied, patch global fetch in debug mode.
		// This patch is scoped to the extension lifecycle (restored on deactivate) and can be restored
		// immediately if the proxy is disabled.
		if (!fetchPatched) {
			if (typeof globalThis.fetch === "function") {
				originalFetch = globalThis.fetch
			}

			globalThis.fetch = undiciFetch as unknown as typeof fetch
			fetchPatched = true
			log(`globalThis.fetch patched to undici.fetch (debug proxy mode)`)

			if (extensionContext) {
				extensionContext.subscriptions.push({
					dispose: () => restoreGlobalFetchPatch(),
				})
			}
		}
	} catch (error) {
		log(`Failed to configure undici proxy dispatcher: ${errorMessage(error)}`)
	}
}
/**
 * Update environment variables for proxy configuration.
 * global-agent reads from GLOBAL_AGENT_* environment variables.
 */
function updateProxyEnvVars(config: ProxyConfig): void {
	if (config.serverUrl) {
		// global-agent uses these environment variables
		process.env.GLOBAL_AGENT_HTTP_PROXY = config.serverUrl
		process.env.GLOBAL_AGENT_HTTPS_PROXY = config.serverUrl
		process.env.GLOBAL_AGENT_NO_PROXY = "" // Proxy all requests
	}
}

/**
 * Check if a proxy is currently configured and active.
 */
export function isProxyEnabled(): boolean {
	const config = getProxyConfig()
	// Active proxy is only applied in debug mode.
	return config.enabled && config.isDebugMode
}

/**
 * Check if we're running in debug mode.
 */
export function isDebugMode(): boolean {
	if (!extensionContext) {
		return false
	}
	return extensionContext.extensionMode === vscode.ExtensionMode.Development
}

/**
 * Log a message to the output channel if available.
 */
function log(message: string): void {
	// log は debug 初期化後にのみ呼ばれる。未初期化時は outputChannel=null かつ
	// consoleLoggingEnabled=false なので、下の 2 分岐がどちらも出力せず実質 no-op になる。
	const logMessage = `[NetworkProxy] ${message}`
	if (outputChannel) {
		outputChannel.appendLine(logMessage)
	}
	if (consoleLoggingEnabled) {
		console.log(logMessage)
	}
}
