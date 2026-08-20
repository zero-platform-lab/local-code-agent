// npx vitest src/components/settings/__tests__/sharedDefaults.spec.ts
import { readFileSync } from "fs"
import { join } from "path"

import {
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_ENABLE_CHECKPOINTS,
	DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS,
	DEFAULT_SHOW_AGENT_IGNORED_FILES,
} from "@openai-agent/types"

/**
 * 既定値が「拡張ホスト側 / webview の初期 state / 保存時フォールバック」の 3 箇所で
 * 逐語重複し、片方だけ変わって静かにずれていた（#266 / #270 / #271）。
 *
 * 値そのものは各所の unit test が担保するので、ここでは**同じ定数を参照していること**を
 * ソース上で固定する。リテラルに戻した瞬間に落ちるので、ドリフトの再発を防げる。
 */

const repoRoot = join(__dirname, "../../../../..")
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8")

const SITES = {
	buildState: "src/core/webview/buildState.ts",
	buildExtensionState: "src/core/webview/buildExtensionState.ts",
	extensionStateContext: "webview-ui/src/context/ExtensionStateContext.tsx",
	settingsView: "webview-ui/src/components/settings/SettingsView.tsx",
	initializeWebview: "src/core/webview/initializeWebview.ts",
} as const

const sources = Object.fromEntries(Object.entries(SITES).map(([name, path]) => [name, read(path)])) as Record<
	keyof typeof SITES,
	string
>

/**
 * 定数ごとに「参照しなければならないファイル」。
 *
 * 設定キーによって既定値を必要とする箇所は違う（例: `autoCondenseContextPercent` は
 * 保存時フォールバックを持たない）。共通の 4 箇所に丸めると
 * 実際の重複箇所を取り逃がすので、キーごとに列挙する。
 */
const REQUIRED_SITES: Record<string, (keyof typeof SITES)[]> = {
	DEFAULT_SHOW_AGENT_IGNORED_FILES: ["buildState", "buildExtensionState", "extensionStateContext", "settingsView"],
	DEFAULT_ENABLE_CHECKPOINTS: ["buildState", "buildExtensionState", "extensionStateContext", "settingsView"],
	DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS: [
		"buildState",
		"buildExtensionState",
		"extensionStateContext",
		"settingsView",
	],
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT: ["buildState", "buildExtensionState", "extensionStateContext"],
}

describe("既定値の単一定義", () => {
	it.each(Object.entries(REQUIRED_SITES))("%s は必要な全箇所から参照されている", (constant, sites) => {
		const missing = sites.filter((site) => !sources[site].includes(constant))

		expect(missing).toEqual([])
	})

	it("実挙動側の値に揃っている", () => {
		// 権威は「実際に絞り込み・適用を行う側」。#271 の実測で特定した値。
		expect(DEFAULT_SHOW_AGENT_IGNORED_FILES).toBe(false)
		expect(DEFAULT_ENABLE_CHECKPOINTS).toBe(true)
		expect(DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS).toBe(5000)
		expect(DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT).toBe(100)
	})

	it("シェル統合タイムアウトの定義は 1 つだけ（BaseTerminal は共有定数を参照する）", () => {
		const baseTerminal = read("src/integrations/terminal/BaseTerminal.ts")

		expect(baseTerminal).toContain("DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS")
		// リテラルを持ち直していないこと
		expect(baseTerminal).not.toMatch(/defaultShellIntegrationTimeout\s*=\s*\d/)
	})

	it("食い違っていた既定値がリテラルとして残っていない", () => {
		// 旧値: ctx 4000 / 保存時 30_000 / showAgentIgnoredFiles true / enableCheckpoints false
		expect(sources.extensionStateContext).not.toContain("terminalShellIntegrationTimeout: 4000")
		expect(sources.settingsView).not.toContain("?? 30_000")
		expect(sources.extensionStateContext).not.toContain("showAgentIgnoredFiles: true")
		expect(sources.settingsView).not.toContain("enableCheckpoints ?? false")
	})

	it("定数化した既定値がリテラルに戻っていない", () => {
		// 数値リテラルで書き直されると、また片側だけ変わってずれる。
		// どのファイルで戻ったかが分かるよう、違反箇所を集めてから比較する。
		const LITERAL_PATTERNS = [/\bautoCondenseContextPercent\s*(\?\?|:)\s*100\b/]

		const violations = Object.entries(sources).flatMap(([site, source]) =>
			LITERAL_PATTERNS.filter((pattern) => pattern.test(source)).map((pattern) => `${site}: ${pattern.source}`),
		)

		expect(violations).toEqual([])
	})
})
