import React, { useCallback } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

interface WebFetchSettingsControlProps {
	webFetchEnabled?: boolean
	onChange: (field: "webFetchEnabled", value: any) => void
}

export const WebFetchSettingsControl: React.FC<WebFetchSettingsControlProps> = ({
	webFetchEnabled = false,
	onChange,
}) => {
	const { t } = useAppTranslation()

	const handleWebFetchEnabledChange = useCallback(
		(e: any) => {
			onChange("webFetchEnabled", e.target.checked)
		},
		[onChange],
	)

	return (
		<div className="flex flex-col gap-1">
			<div>
				<VSCodeCheckbox checked={webFetchEnabled} onChange={handleWebFetchEnabledChange}>
					<span className="font-medium">{t("settings:advanced.webFetch.label")}</span>
				</VSCodeCheckbox>
				<div className="text-vscode-descriptionForeground text-sm">
					{t("settings:advanced.webFetch.description")}
				</div>
			</div>
		</div>
	)
}
