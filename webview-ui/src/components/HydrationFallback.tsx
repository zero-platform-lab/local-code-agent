import { Button } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface HydrationFallbackProps {
	/** これまでに送った `webviewDidLaunch` の回数。 */
	attempts: number
	/** 自動再送の上限。到達したら手動の再試行に切り替える。 */
	maxAttempts: number
	onRetry: () => void
}

/**
 * 拡張から初回の `state` が届くまでの繋ぎ。
 *
 * 以前はこの間ずっと `null` を返していたため、`state` が 1 回でも落ちると webview は
 * 無言のまま真っ白で固まり、パネルを開き直す以外に復帰手段が無かった。自動再送中は
 * 通常起動でのちらつきを避けて静かにし、再送を使い切ってから状況と再試行手段を出す。
 */
export const HydrationFallback = ({ attempts, maxAttempts, onRetry }: HydrationFallbackProps) => {
	const { t } = useAppTranslation()

	// 1 回目の送信中は何も描かない。通常の起動はここで終わる。
	if (attempts < 2) {
		return null
	}

	if (attempts < maxAttempts) {
		return <div className="p-4 text-sm text-vscode-descriptionForeground">{t("common:hydration.loading")}</div>
	}

	return (
		<div className="p-4 flex flex-col items-start gap-3">
			<h2 className="text-lg font-bold m-0">{t("common:hydration.title")}</h2>
			<p className="m-0 text-sm text-vscode-descriptionForeground">{t("common:hydration.description")}</p>
			<Button onClick={onRetry}>{t("common:hydration.retry")}</Button>
		</div>
	)
}

export default HydrationFallback
