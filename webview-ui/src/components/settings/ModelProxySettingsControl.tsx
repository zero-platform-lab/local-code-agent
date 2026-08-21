import { useCallback } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings, OpenAiProxyMode } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { inputEventTransform } from "./transforms"

type ModelProxySettingsControlProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

/** URL が入っていれば custom、空なら direct（＝明示的に proxy を使わない）。 */
function modeForUrl(url: string): OpenAiProxyMode {
	return url.trim() ? "custom" : "direct"
}

/**
 * API 設定プロファイル単位の proxy を編集するコントロール。
 *
 * 値はプロファイルに保存される。VS Code の `http.proxy` はマシン全体に 1 つしか無く、
 * SOCKS 経由のモデルと直結のモデルが混在する環境では片方が必ず通らないため、
 * モデル側で上書きできるようにする。
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
export const ModelProxySettingsControl = ({
	apiConfiguration,
	setApiConfigurationField,
}: ModelProxySettingsControlProps) => {
	const { t } = useAppTranslation()

	// 未設定は inherit 扱い（既存プロファイルは触らなくても従来どおり動く）。
	const mode: OpenAiProxyMode = apiConfiguration?.openAiProxyMode ?? "inherit"
	const enabled = mode !== "inherit"
	const url = apiConfiguration?.openAiProxyUrl ?? ""

	const handleToggle = useCallback(
		(checked: boolean) => {
			setApiConfigurationField("openAiProxyMode", checked ? modeForUrl(url) : "inherit")
		},
		[setApiConfigurationField, url],
	)

	const handleUrlChange = useCallback(
		(event: unknown) => {
			// 値の取り出しはフォーム内の他フィールドと同じ helper を使う。
			const next = inputEventTransform(event) as string
			setApiConfigurationField("openAiProxyUrl", next)
			// URL の有無で custom / direct が決まるので、モードも追従させる。
			// 有効なときだけ。OFF のまま入力しても inherit を壊さない。
			if (enabled) {
				setApiConfigurationField("openAiProxyMode", modeForUrl(next))
			}
		},
		[setApiConfigurationField, enabled],
	)

	return (
		<div className="flex flex-col gap-1">
			<Checkbox checked={enabled} onChange={handleToggle} data-testid="model-proxy-enable-checkbox">
				{t("settings:proxy.model.enable")}
			</Checkbox>
			<div className="text-sm text-vscode-descriptionForeground ml-6">
				{t("settings:proxy.model.description")}
			</div>
			<VSCodeTextField
				value={url}
				onInput={handleUrlChange}
				disabled={!enabled}
				placeholder="socks5://127.0.0.1:1080"
				data-testid="model-proxy-url-input"
				className="w-full">
				{t("settings:proxy.model.urlLabel")}
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground">{t("settings:proxy.model.blankIsDirect")}</div>
		</div>
	)
}
