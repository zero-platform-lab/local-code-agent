import { useCallback, useState } from "react"
import { useEvent, useMount } from "react-use"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ExtensionMessage } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

const SETTING = "openai-agent.proxyUrl"

/**
 * 拡張独自の proxy 設定（VS Code 設定 `openai-agent.proxyUrl`）を編集するコントロール。
 *
 * 「VS Code の proxy 設定に従う（既定）」チェックボックスと、外したときに現れる URL 欄。
 * 空欄なら VS Code の `http.proxy` / 環境変数に追従、値があれば全 outbound で上書きする。
 * `http(s)://` と `socks5://` に対応。値の実体は VS Code 設定なので get/updateVSCodeSetting
 * ブリッジ経由で読み書きする（provider プロファイルとは独立）。
 */
export const ProxySettingsControl = () => {
	const { t } = useAppTranslation()
	const [proxyUrl, setProxyUrl] = useState<string>("")
	const [custom, setCustom] = useState<boolean>(false)

	useMount(() => vscode.postMessage({ type: "getVSCodeSetting", setting: SETTING }))

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (message.type === "vsCodeSetting" && message.setting === SETTING) {
			const value = typeof message.value === "string" ? message.value : ""
			setProxyUrl(value)
			setCustom(value.length > 0)
		}
	}, [])
	useEvent("message", onMessage)

	const write = useCallback((value: string) => {
		vscode.postMessage({ type: "updateVSCodeSetting", setting: SETTING, value })
	}, [])

	const handleFollowDefaultChange = useCallback(
		(e: any) => {
			const followDefault = e.target.checked
			if (followDefault) {
				// 既定に戻す = URL をクリアして VS Code / env に追従。
				setCustom(false)
				setProxyUrl("")
				write("")
			} else {
				setCustom(true)
			}
		},
		[write],
	)

	const handleUrlChange = useCallback(
		(e: any) => {
			const value = String(e.target.value)
			setProxyUrl(value)
			write(value)
		},
		[write],
	)

	return (
		<div className="flex flex-col gap-1">
			<div>
				<VSCodeCheckbox
					checked={!custom}
					onChange={handleFollowDefaultChange}
					data-testid="proxy-follow-default-checkbox">
					<span className="font-medium">{t("settings:proxy.followDefault.label")}</span>
				</VSCodeCheckbox>
				<div className="text-vscode-descriptionForeground text-sm">
					{t("settings:proxy.followDefault.description")}
				</div>
			</div>
			{custom && (
				<VSCodeTextField
					value={proxyUrl}
					onInput={handleUrlChange}
					placeholder="socks5://127.0.0.1:1080"
					data-testid="proxy-url-input"
					className="w-full">
					{t("settings:proxy.url.label")}
				</VSCodeTextField>
			)}
		</div>
	)
}
