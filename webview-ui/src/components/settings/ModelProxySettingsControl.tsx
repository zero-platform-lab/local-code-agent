import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings, OpenAiProxyMode } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

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
 * `direct` があるのは「未設定＝継承」だけでは**直結を明示できない**ため。VS Code 側に
 * proxy がある状態で直結のモデルを使う、という構成がこれ無しでは組めない。
 */
export const ModelProxySettingsControl = ({
	apiConfiguration,
	setApiConfigurationField,
}: ModelProxySettingsControlProps) => {
	const { t } = useAppTranslation()

	// 未設定は "inherit" として扱う（既存プロファイルは触らなくても従来どおり動く）。
	const mode: OpenAiProxyMode = apiConfiguration?.openAiProxyMode ?? "inherit"

	const handleModeChange = useCallback(
		(value: string) => {
			setApiConfigurationField("openAiProxyMode", value as OpenAiProxyMode)
		},
		[setApiConfigurationField],
	)

	const handleUrlChange = useCallback(
		(e: any) => {
			setApiConfigurationField("openAiProxyUrl", String(e.target.value))
		},
		[setApiConfigurationField],
	)

	return (
		<div className="flex flex-col gap-1">
			<label className="block font-medium mb-1">{t("settings:proxy.model.label")}</label>
			<Select value={mode} onValueChange={handleModeChange}>
				<SelectTrigger className="w-full" data-testid="model-proxy-mode-select">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="inherit">{t("settings:proxy.model.inherit")}</SelectItem>
					<SelectItem value="direct">{t("settings:proxy.model.direct")}</SelectItem>
					<SelectItem value="custom">{t("settings:proxy.model.custom")}</SelectItem>
				</SelectContent>
			</Select>
			<div className="text-vscode-descriptionForeground text-sm">{t("settings:proxy.model.description")}</div>
			{mode === "custom" && (
				<VSCodeTextField
					value={apiConfiguration?.openAiProxyUrl || ""}
					onInput={handleUrlChange}
					placeholder="socks5://127.0.0.1:1080"
					data-testid="model-proxy-url-input"
					className="w-full">
					{t("settings:proxy.model.urlLabel")}
				</VSCodeTextField>
			)}
		</div>
	)
}
