import { useCallback } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { OpenAiProxyMode } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { inputEventTransform } from "./transforms"

/** URL が入っていれば custom、空なら direct（＝明示的に proxy を使わない）。 */
export function modeForUrl(url: string): OpenAiProxyMode {
	return url.trim() ? "custom" : "direct"
}

type ProxySettingsControlProps = {
	mode: OpenAiProxyMode | undefined
	url: string | undefined
	onChange: (next: { mode: OpenAiProxyMode; url: string }) => void
	/** 選ばせない理由がある場合に真。SSH の取得元では proxy が効かない（`FR-UI-29a`）。 */
	disabled?: boolean
	/** チェックボックスと URL 欄に付ける `data-testid` の接頭辞。 */
	testIdPrefix: string
	labels: {
		enable: string
		description: string
		urlLabel: string
		blankIsDirect: string
	}
}

/**
 * proxy の 3 状態を編集する部品。接続先のプロファイルと、スキルの取得元で共用する。
 *
 * 3 状態をチェックボックス 1 つと URL 欄で表す。URL 欄は**常に見せる**（OFF のときは
 * 無効化するだけ）。条件付きで消すと、値が残っているのに消えたように見える。
 *
 * - OFF                → `inherit`（VS Code の設定に従う）
 * - ON かつ URL あり   → `custom`（その URL を使う）
 * - ON かつ URL 空     → `direct`（proxy を使わない）
 *
 * 「ON なのに空欄」が直結を意味するのは説明が要るので、欄の下に明記する。
 */
export const ProxySettingsControl = ({
	mode,
	url,
	onChange,
	disabled,
	testIdPrefix,
	labels,
}: ProxySettingsControlProps) => {
	const { t } = useAppTranslation()
	void t

	// 未設定は inherit 扱い（既存の設定は触らなくても従来どおり動く）。
	const currentMode: OpenAiProxyMode = mode ?? "inherit"
	const enabled = currentMode !== "inherit"
	const currentUrl = url ?? ""

	const handleToggle = useCallback(
		(checked: boolean) => {
			onChange({ mode: checked ? modeForUrl(currentUrl) : "inherit", url: currentUrl })
		},
		[onChange, currentUrl],
	)

	const handleUrlChange = useCallback(
		(event: unknown) => {
			// 値の取り出しはフォーム内の他フィールドと同じ helper を使う。
			const next = inputEventTransform(event) as string
			// URL の有無で custom / direct が決まるので、モードも追従させる。
			// 有効なときだけ。OFF のまま入力しても inherit を壊さない。
			onChange({ mode: enabled ? modeForUrl(next) : currentMode, url: next })
		},
		[onChange, enabled, currentMode],
	)

	return (
		<div className="flex flex-col gap-1">
			<Checkbox checked={enabled} onChange={handleToggle} data-testid={`${testIdPrefix}-enable-checkbox`}>
				{labels.enable}
			</Checkbox>
			<div className="text-sm text-vscode-descriptionForeground ml-6">{labels.description}</div>
			<VSCodeTextField
				value={currentUrl}
				onInput={handleUrlChange}
				disabled={!enabled || disabled}
				placeholder="socks5://127.0.0.1:1080"
				data-testid={`${testIdPrefix}-url-input`}
				className="w-full">
				{labels.urlLabel}
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground">{labels.blankIsDirect}</div>
		</div>
	)
}
