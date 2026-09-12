import { useCallback } from "react"

import type { ProviderSettings } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { ProxySettingsControl } from "./ProxySettingsControl"

type ModelProxySettingsControlProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

/**
 * API 設定プロファイル単位の proxy を編集するコントロール。
 *
 * 値はプロファイルに保存される。VS Code の `http.proxy` はマシン全体に 1 つしか無く、
 * SOCKS 経由のモデルと直結のモデルが混在する環境では片方が必ず通らないため、
 * モデル側で上書きできるようにする。
 *
 * 3 状態の見せ方そのものは `ProxySettingsControl` が持つ。**スキルの取得元と同じ部品を
 * 使う**ので、選択肢の意味（継承・直結・個別）が 2 か所でずれない（`FR-NET-12e`）。
 */
export const ModelProxySettingsControl = ({
	apiConfiguration,
	setApiConfigurationField,
}: ModelProxySettingsControlProps) => {
	const { t } = useAppTranslation()

	const handleChange = useCallback(
		({ mode, url }: { mode: ProviderSettings["openAiProxyMode"]; url: string }) => {
			setApiConfigurationField("openAiProxyMode", mode)
			if (url !== (apiConfiguration?.openAiProxyUrl ?? "")) {
				setApiConfigurationField("openAiProxyUrl", url)
			}
		},
		[setApiConfigurationField, apiConfiguration?.openAiProxyUrl],
	)

	return (
		<ProxySettingsControl
			mode={apiConfiguration?.openAiProxyMode}
			url={apiConfiguration?.openAiProxyUrl}
			onChange={handleChange}
			testIdPrefix="model-proxy"
			labels={{
				enable: t("settings:proxy.model.enable"),
				description: t("settings:proxy.model.description"),
				urlLabel: t("settings:proxy.model.urlLabel"),
				blankIsDirect: t("settings:proxy.model.blankIsDirect"),
			}}
		/>
	)
}
