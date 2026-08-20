/**
 * HTTP(S) / SOCKS5 proxy dispatcher for outbound requests.
 *
 * Model（API 設定プロファイル）単位の指定を最優先で見る。指定が無ければ VS Code の
 * `http.proxy` / `HTTPS_PROXY` 等に追従する。これ 1 箇所を SDK・接続テスト・web_fetch の
 * 全経路が通るため、ここで解決した dispatcher が outbound すべてに効く。
 *
 * - `http(s)://…`  → undici の ProxyAgent（HTTP CONNECT）
 * - `socks5://…` / `socks5h://…` / `socks4://…` → socks で張った socket を undici に
 *   渡す SOCKS dispatcher（undici ProxyAgent は SOCKS 非対応のため自作）
 *
 * 参考: Node 20+ の built-in fetch は環境変数 `HTTPS_PROXY` を自動では見ないため、
 * `fetchOptions.dispatcher` で明示指定が要る。
 */

import * as vscode from "vscode"
import { ProxyAgent, Agent, buildConnector, type Dispatcher } from "undici"
import { SocksClient } from "socks"

// URL 単位でキャッシュする。単一エントリだと、SOCKS 経由のモデルと直結のモデルを
// 交互に使うたびに dispatcher を作り直すことになる（接続プールも毎回捨てる）。
const cached = new Map<string, Dispatcher>()

/**
 * VS Code の `http.proxy` 設定と `HTTPS_PROXY` / `HTTP_PROXY` 環境変数から proxy URL を解決する。
 *
 * 優先順: VS Code `http.proxy` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`/`http_proxy`
 */
export function resolveProxyUrl(): string | undefined {
	try {
		const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy")
		if (vscodeProxy && vscodeProxy.trim()) return vscodeProxy.trim()
	} catch {
		// vscode API が使えない環境（テスト等）は環境変数のみ見る。
	}

	const env = process.env
	const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
	return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}

/**
 * 本物の VS Code が proxy を管理しているか。
 *
 * VS Code は `http.proxySupport`（既定 "override"）で proxy を自前解決し、拡張の
 * ネットワークにも注入する。認証（NTLM/Kerberos）や PAC もそこが扱う。その環境で
 * 自前 ProxyAgent を重ねると VS Code の解決を上書きし、認証付き proxy でしか通らない
 * エンドポイントが全リクエスト落ちる（実際に起きた）。**ただし拡張独自 proxy を明示設定
 * した場合はユーザーの意図が優先なので、この判定より前に上書きする**（getProxyDispatcher）。
 */
function isVsCodeManagedProxy(): boolean {
	try {
		const support = vscode.workspace.getConfiguration("http").get<string>("proxySupport")
		return typeof support === "string" && support !== "off"
	} catch {
		return false
	}
}

/** URL のスキームが SOCKS 系か。 */
function isSocksUrl(protocol: string): boolean {
	return /^socks(4|4a|5|5h)?:$/i.test(protocol)
}

/**
 * SOCKS proxy 経由の undici Dispatcher を作る。undici の ProxyAgent は SOCKS 非対応
 * なので、`socks` で張った socket を undici の connector に渡して（必要なら TLS 化）返す。
 */
export function buildSocksDispatcher(parsed: URL): Dispatcher {
	const type: 4 | 5 = /^socks4/i.test(parsed.protocol) ? 4 : 5
	const host = parsed.hostname
	const port = Number(parsed.port) || 1080
	const userId = parsed.username ? decodeURIComponent(parsed.username) : undefined
	const password = parsed.password ? decodeURIComponent(parsed.password) : undefined
	const undiciConnect = buildConnector({})

	return new Agent({
		/* v8 ignore start -- 実 SOCKS proxy と実ソケットが要るネットワーク境界。リクエスト時のみ
		   呼ばれ、単体では到達しない（socks/undici の内部を厚くモックしない限り踏めない）。 */
		connect: (opts, callback) => {
			SocksClient.createConnection({
				proxy: { host, port, type, userId, password },
				command: "connect",
				destination: {
					host: String(opts.hostname),
					port: Number(opts.port) || (String(opts.protocol) === "https:" ? 443 : 80),
				},
			})
				.then(({ socket }) => {
					// 既存 socket を渡すと、https のときは undici が TLS 化して返す。
					undiciConnect({ ...opts, httpSocket: socket } as Parameters<typeof undiciConnect>[0], callback)
				})
				.catch((err: Error) => callback(err, null))
		},
		/* v8 ignore stop */
	})
}

/** proxy URL に対応する undici Dispatcher を作る。スキームで http / socks を分岐。 */
function buildDispatcher(url: string): Dispatcher | undefined {
	const hit = cached.get(url)
	if (hit) return hit
	try {
		const parsed = new URL(url)
		const dispatcher = isSocksUrl(parsed.protocol) ? buildSocksDispatcher(parsed) : new ProxyAgent({ uri: url })
		cached.set(url, dispatcher)
		return dispatcher
	} catch {
		// URL 不正 / undici が使えない環境は proxy 無し扱い。
		return undefined
	}
}

/** proxy の解決結果と、その由来。 */
export type ProxyResolution = {
	/**
	 * 実際に使う proxy URL。未設定のときと、VS Code 管理へ委ねるときは undefined。
	 * 後者で URL を返せないのは、解決を持っているのが VS Code 側で拡張からは
	 * 見えないため（"何も通していない" とは意味が違う）。
	 */
	url: string | undefined
	source: "none" | "profile" | "profile-direct" | "vscode-managed" | "vscode-http-proxy" | "env"
}

/**
 * Model（API 設定プロファイル）単位の proxy 指定。
 *
 * `direct` が要るのは、**全体設定を上書きして直結に落とす**ため。全体に SOCKS を
 * 入れた環境に直結のモデルが混在する場合、「未設定＝継承」しか無いと直結を表現できない。
 */
export type ProxyOverride = {
	mode?: "inherit" | "direct" | "custom"
	url?: string
}

/**
 * outbound proxy をどこから取るかを 1 箇所で決める。
 *
 * 優先順:
 * 1. Model 単位の指定（`direct` なら proxy 無し、`custom` ならその URL。http(s)/socks5 対応）
 * 2. 本物の VS Code 管理下なら委ねる（拡張は dispatcher を張らない）
 * 3. VS Code `http.proxy` / env（CLI や proxySupport="off" のとき）
 *
 * 実際の通信（getProxyDispatcher）と接続テストの診断表示が、どちらもここを通る。
 * 別々に解決していると「実際は拡張設定の SOCKS 経由で飛んでいるのに、診断は
 * `Proxy: (none)` と表示する」というズレが出る（実際に起きていた）。診断は切り分けの
 * ための機能なので、そこが実態とズレると用を成さない。
 */
export function resolveEffectiveProxy(override?: ProxyOverride): ProxyResolution {
	if (override?.mode === "direct") return { url: undefined, source: "profile-direct" }

	if (override?.mode === "custom") {
		const perModel = override.url?.trim()
		if (perModel) return { url: perModel, source: "profile" }
		// "custom" を選んだが URL 未入力。設定途中で通信を壊さないよう継承に落とす。
	}

	if (isVsCodeManagedProxy()) return { url: undefined, source: "vscode-managed" }

	const url = resolveProxyUrl()
	if (!url) return { url: undefined, source: "none" }

	const env = process.env
	const fromEnv =
		env.HTTPS_PROXY === url || env.https_proxy === url || env.HTTP_PROXY === url || env.http_proxy === url
	return { url, source: fromEnv ? "env" : "vscode-http-proxy" }
}

/**
 * outbound に使う undici Dispatcher を返す。設定が無ければ undefined。
 * 解決そのものは resolveEffectiveProxy に委ねる。
 *
 * 同期版。コンストラクタから呼ぶことがあるため await できるとは限らない。
 */
export function getProxyDispatcher(override?: ProxyOverride): Dispatcher | undefined {
	const { url } = resolveEffectiveProxy(override)
	if (!url) return undefined
	return buildDispatcher(url)
}

/** テスト用にキャッシュを破棄する。 */
export function _resetProxyDispatcherCache(): void {
	cached.clear()
}
