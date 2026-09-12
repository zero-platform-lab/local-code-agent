import type { OpenAiProxyMode } from "@openai-agent/types"

import { resolveEffectiveProxy } from "../../utils/proxyDispatcher"

import type { SkillSourceTransport } from "./skillSourcePath"

/**
 * スキルの取得で git へ渡す設定を組み立てる。
 *
 * **proxy は解決だけを共有し、転送は git が行う**（`FR-NET-13a`）。clone はスマート
 * HTTP のやり取りを自前で実装することになるため、`getProxyDispatcher` は通さない。
 * 解決には LLM 側と同じ `resolveEffectiveProxy` を使うので、継承・直結・個別の 3 択
 * （`FR-NET-12e`）の意味はそろう。
 *
 * ここは git を起動しない純粋な組み立てだけを持つ。実際の取得は呼び出し側が行う。
 */

export type SkillSourceProxy = {
	mode?: OpenAiProxyMode
	url?: string
}

export type GitInvocation = {
	/** `git -c <...>` へ渡す設定。 */
	config: string[]
	/** git へ渡す環境変数。 */
	env: Record<string, string>
	/** SSH の取得元に proxy を指定していた。git は黙って無視するので、呼び出し側が伝える。 */
	proxyIgnored: boolean
	/** 記録に出してよい形の proxy の URL。資格情報は伏せてある。 */
	proxyForLog?: string
}

/**
 * SOCKS の名前の解決を proxy 側へ寄せる（`FR-NET-12a1` `FR-EXT-05b2`）。
 *
 * git の `http.proxy` は libcurl へ渡る。libcurl は `socks5` をクライアント側の解決、
 * `socks5h` を proxy 側の解決として扱う。**拡張の dispatcher はホスト名をそのまま
 * SOCKS へ渡す**ので、書き換えないと同じ設定でも経路によって解決する場所が変わり、
 * 社内の名前が引けない環境で取得だけが失敗する。
 *
 * `socks4` にも同じ理由で `socks4a` を当てる。
 */
export function preferProxySideDns(proxyUrl: string): string {
	return proxyUrl.replace(/^socks5:\/\//i, "socks5h://").replace(/^socks4:\/\//i, "socks4a://")
}

/**
 * 記録へ出す前に、proxy の URL から利用者名とパスワードを落とす（`FR-EXT-06e`）。
 * `socks5h://user:pass@host:1080` の形が書けるため、そのまま出すと資格情報が残る。
 */
export function redactProxyUrl(proxyUrl: string): string {
	return proxyUrl.replace(/^([a-z0-9+.-]+:\/\/)[^@/]*@/i, "$1<伏せた>@")
}

export function buildGitInvocation(transport: SkillSourceTransport, proxy?: SkillSourceProxy): GitInvocation {
	const env: Record<string, string> = {
		// **入力を待たずに失敗させる**（`FR-EXT-06d`）。待つと、画面の無いところで
		// git が止まったままになる。
		GIT_TERMINAL_PROMPT: "0",
	}

	const resolved = resolveEffectiveProxy(proxy ? { mode: proxy.mode, url: proxy.url } : undefined)

	if (!resolved.url) {
		return { config: [], env, proxyIgnored: false }
	}

	if (transport === "ssh") {
		// `http.proxy` は SSH の取得元では完全に無視される。渡さずに、無視される旨を
		// 呼び出し側へ返す（`FR-EXT-05b3`）。
		return { config: [], env, proxyIgnored: true }
	}

	const proxyUrl = preferProxySideDns(resolved.url)

	return {
		config: [`http.proxy=${proxyUrl}`],
		env,
		proxyIgnored: false,
		proxyForLog: redactProxyUrl(proxyUrl),
	}
}
