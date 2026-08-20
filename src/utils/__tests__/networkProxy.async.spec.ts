// initializeNetworkProxy の「await して global-agent / undici まで通す」非同期経路の網羅。
//
// networkProxy は proxyInitialized / undiciProxyInitialized / fetchPatched などの
// モジュール単位シングルトン状態を持つ。既存の networkProxy.spec.ts は `void init`
// （投げっぱなし）で状態を汚すため、こちらは別ファイルに分離し（Vitest はファイル単位で
// モジュールを隔離する）、各テストで vi.resetModules() して新しいインスタンスを検証する。

// global-agent / undici のモックは vi.hoisted で安定した参照を作り、resetModules をまたいで
// 同じ関数実体を共有する（SUT が実際に呼んだかを確実に検証できる）。
const proxyMocks = vi.hoisted(() => ({
	bootstrap: vi.fn(),
	ProxyAgent: vi.fn(),
	setGlobalDispatcher: vi.fn(),
	undiciFetch: vi.fn(),
}))

vi.mock("global-agent", () => ({ bootstrap: proxyMocks.bootstrap }))

// global-agent の import 自体を throw させるヘルパ（load 失敗の検証用）。
// このモックは最後のテストでのみ使い、復元しない（以降のテストが無いため競合しない）。
function mockGlobalAgentThrow(err: unknown) {
	vi.resetModules()
	vi.doUnmock("global-agent")
	vi.doMock("global-agent", () => {
		throw err
	})
}

vi.mock("undici", () => ({
	ProxyAgent: proxyMocks.ProxyAgent,
	setGlobalDispatcher: proxyMocks.setGlobalDispatcher,
	fetch: proxyMocks.undiciFetch,
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	},
	ExtensionMode: { Development: 2, Production: 1, Test: 3 },
}))

// テスト開始時点の本物の fetch を退避（各テスト後に必ず戻す）。
const REAL_GLOBAL_FETCH = globalThis.fetch

const DEV = 2 // vscode.ExtensionMode.Development

async function flush() {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0))
	}
}

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
	// リスナ内の configureGlobalProxy/configureUndiciProxy は await されない投げっぱなしで、
	// 内部の動的 import(mock) が複数タスク跨ぎで解決する。負荷に依存しないよう条件成立まで待つ。
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: 条件が時間内に成立しませんでした")
		}
		await new Promise((r) => setTimeout(r, 5))
	}
}

describe("initializeNetworkProxy - async proxy configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// hoisted モックは clearAllMocks で実装も消えるので既定実装を戻す。
		proxyMocks.bootstrap.mockImplementation(() => {})
		proxyMocks.ProxyAgent.mockImplementation(function (this: any, opts: any) {
			this.__opts = opts
		})
		proxyMocks.setGlobalDispatcher.mockImplementation(() => {})
		delete process.env.GLOBAL_AGENT_HTTP_PROXY
		delete process.env.GLOBAL_AGENT_HTTPS_PROXY
		delete process.env.GLOBAL_AGENT_NO_PROXY
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
	})

	afterEach(async () => {
		// リスナ経由の投げっぱなし非同期を次テストへ持ち越さないよう流し切ってから後始末する。
		await flush()
		globalThis.fetch = REAL_GLOBAL_FETCH
		delete process.env.GLOBAL_AGENT_HTTP_PROXY
		delete process.env.GLOBAL_AGENT_HTTPS_PROXY
		delete process.env.GLOBAL_AGENT_NO_PROXY
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
	})

	async function freshImport() {
		vi.resetModules()
		const vscodeMod: any = await import("vscode")
		const np: any = await import("../networkProxy")
		return { vscodeMod, np }
	}

	function makeChannel() {
		return { appendLine: vi.fn(), append: vi.fn(), clear: vi.fn(), show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }
	}

	function makeContext(mode: number) {
		return { extensionMode: mode, subscriptions: [] as any[] } as any
	}

	function setConfig(vscodeMod: any, values: { enabled?: boolean; serverUrl?: string; tlsInsecure?: boolean }) {
		vscodeMod.workspace.getConfiguration.mockReturnValue({
			get: (key: string) => {
				if (key === "debugProxy.enabled") return values.enabled ?? false
				if (key === "debugProxy.serverUrl") return values.serverUrl ?? ""
				if (key === "debugProxy.tlsInsecure") return values.tlsInsecure ?? false
				return ""
			},
		})
	}

	it("debug + enabled + tlsInsecure: global-agent と undici を構成し fetch をパッチする", async () => {
		const { vscodeMod, np } = await freshImport()
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: true })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await np.initializeNetworkProxy(context, channel)

		expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBe("http://localhost:8080")
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")
		expect(proxyMocks.bootstrap).toHaveBeenCalledTimes(1)
		expect(proxyMocks.setGlobalDispatcher).toHaveBeenCalledTimes(1)
		// tlsInsecure=true → requestTls/proxyTls に rejectUnauthorized:false を渡す。
		expect(proxyMocks.ProxyAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				uri: "http://localhost:8080",
				requestTls: { rejectUnauthorized: false },
				proxyTls: { rejectUnauthorized: false },
			}),
		)
		expect(globalThis.fetch).toBe(proxyMocks.undiciFetch)
		expect(channel.appendLine).toHaveBeenCalled()

		// 登録された dispose を全て呼び、restore 経路（fetch/TLS 復元）を通す。
		for (const sub of context.subscriptions) {
			if (typeof sub?.dispose === "function") sub.dispose()
		}
		expect(globalThis.fetch).toBe(REAL_GLOBAL_FETCH)
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
	})

	it("debug + enabled + tlsInsecure=false + チャンネル無し: console ログ、ProxyAgent は tls 無し", async () => {
		const { vscodeMod, np } = await freshImport()
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://127.0.0.1:9999", tlsInsecure: false })
		const context = makeContext(DEV)
		const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		// チャンネルを渡さない → consoleLoggingEnabled=true 経路。
		await np.initializeNetworkProxy(context, undefined)

		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
		expect(proxyMocks.ProxyAgent).toHaveBeenCalledWith(
			expect.objectContaining({ uri: "http://127.0.0.1:9999", requestTls: undefined, proxyTls: undefined }),
		)
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("[NetworkProxy]"))

		consoleLogSpy.mockRestore()
	})

	it("二重初期化では global-agent / undici を再構成しない（初期化済み分岐）", async () => {
		const { vscodeMod, np } = await freshImport()
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await np.initializeNetworkProxy(context, channel)
		await np.initializeNetworkProxy(context, channel)

		expect(proxyMocks.bootstrap).toHaveBeenCalledTimes(1)
		expect(proxyMocks.setGlobalDispatcher).toHaveBeenCalledTimes(1)
	})

	it("設定変更リスナ: 有効化で再構成、無効化で fetch/TLS を復元する", async () => {
		const { vscodeMod, np } = await freshImport()
		// 最初は無効（else 分岐 "not enabled" を通す）。
		setConfig(vscodeMod, { enabled: false, serverUrl: "http://localhost:8080", tlsInsecure: true })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await np.initializeNetworkProxy(context, channel)
		expect(proxyMocks.bootstrap).not.toHaveBeenCalled()

		// 登録された onDidChangeConfiguration のコールバックを取り出す。
		const cb = vscodeMod.workspace.onDidChangeConfiguration.mock.calls[0][0]
		const affectsEnabled = { affectsConfiguration: (k: string) => k.endsWith("debugProxy.enabled") }
		const affectsNothing = { affectsConfiguration: () => false }

		// 無関係な変更では何も起きない。
		cb(affectsNothing)
		await flush()
		expect(proxyMocks.bootstrap).not.toHaveBeenCalled()

		// 復元経路の string 分岐を通すため、事前に文字列で設定しておく。
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1"

		// 有効化 → 構成が走る（コールバックは await されない。global-agent と undici の両方が
		// 完了する＝bootstrap 実行かつ fetch パッチ済みになるまで、負荷非依存で待つ）。
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: true })
		cb(affectsEnabled)
		await waitFor(() => proxyMocks.bootstrap.mock.calls.length >= 1 && globalThis.fetch === proxyMocks.undiciFetch)
		expect(proxyMocks.bootstrap).toHaveBeenCalledTimes(1)
		// applyTlsVerificationOverride は同期実行なので NODE_TLS は既に "0"。
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")

		// 無効化 → else 分岐（同期）で fetch パッチと TLS を即時復元。
		setConfig(vscodeMod, { enabled: false, serverUrl: "http://localhost:8080", tlsInsecure: true })
		cb(affectsEnabled)
		expect(globalThis.fetch).toBe(REAL_GLOBAL_FETCH)
		// 事前に保存した文字列 "1" に戻る（string 分岐）。
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
	})

	it("初期化前の getProxyConfig は既定値、isDebugMode は false を返す", async () => {
		const { np } = await freshImport()

		const config = np.getProxyConfig()
		expect(config.enabled).toBe(false)
		expect(config.serverUrl).toBe("http://127.0.0.1:8888")
		expect(config.isDebugMode).toBe(false)
		expect(np.isDebugMode()).toBe(false)
		expect(np.isProxyEnabled()).toBe(false)
	})

	it("serverUrl が不正 URL でも redact のフォールバックで例外を投げない", async () => {
		const { vscodeMod, np } = await freshImport()
		setConfig(vscodeMod, { enabled: true, serverUrl: ":::not-a-url:::", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await expect(np.initializeNetworkProxy(context, channel)).resolves.toBeUndefined()
		expect(channel.appendLine).toHaveBeenCalled()
	})

	it("global-agent の bootstrap が失敗しても初期化は例外を投げない", async () => {
		const { vscodeMod, np } = await freshImport()
		proxyMocks.bootstrap.mockImplementation(() => {
			throw new Error("bootstrap failed")
		})
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await expect(np.initializeNetworkProxy(context, channel)).resolves.toBeUndefined()
		expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("bootstrap() FAILED"))
	})

	it("undici の構成でエラーが起きても初期化は例外を投げない", async () => {
		const { vscodeMod, np } = await freshImport()
		proxyMocks.ProxyAgent.mockImplementation(() => {
			throw new Error("undici boom")
		})
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await expect(np.initializeNetworkProxy(context, channel)).resolves.toBeUndefined()
		expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to configure undici proxy"))
	})

	// 各 catch のログは `error instanceof Error ? error.message : String(error)`。
	// 上のテストで Error 側を通したので、ここでは Error 以外（文字列）で String(error) 側を通す。
	it("bootstrap が Error 以外で失敗しても String(error) で整形して続行する", async () => {
		const { vscodeMod, np } = await freshImport()
		proxyMocks.bootstrap.mockImplementation(() => {
			throw "bootstrap string failure"
		})
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await expect(np.initializeNetworkProxy(context, channel)).resolves.toBeUndefined()
		expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("bootstrap string failure"))
	})

	// global-agent の import 自体を throw させる（doMock）。以降のテストは無いので復元しない。
	// これを最後に置くことで、他テストと global-agent モック状態が競合しない。
	it("global-agent の読み込み自体が失敗しても初期化は続行する", async () => {
		mockGlobalAgentThrow(new Error("cannot load global-agent"))
		const vscodeMod: any = await import("vscode")
		const np: any = await import("../networkProxy")
		setConfig(vscodeMod, { enabled: true, serverUrl: "http://localhost:8080", tlsInsecure: false })
		const context = makeContext(DEV)
		const channel = makeChannel()

		await expect(np.initializeNetworkProxy(context, channel)).resolves.toBeUndefined()
		expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to load global-agent"))
	})
})
