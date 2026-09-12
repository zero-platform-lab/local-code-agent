import React, { useCallback } from "react"
import { Shield, ShieldOff } from "lucide-react"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { StandardTooltip, Button } from "@src/components/ui"

/**
 * シークレットモードの切り替え。
 *
 * **目的。** 送信の直前に伏せるかどうかを、設定の画面を開かずに決められるようにする
 * （`FR-PII-01b`）。送る直前に切り替えたい場面があるので、指示を送る画面に置く。
 *
 * **仕組み。** 押すと `piiMasking.enabled` を書き換えて保存する。設定の画面と違い、
 * 保存の操作を挟まない。ここは設定の編集ではなく、送る直前の選択だからである。
 *
 * **いま入っているかが一目で分かるようにする。** 入っているのに気づかないと、伏せ字が
 * 混ざった応答を見て混乱する。切れているのに気づかないと、伏せたつもりで送ってしまう。
 * 後者のほうが害が大きいので、入っているときを目立たせる。
 */
export const SecretModeToggle: React.FC<{ className?: string }> = ({ className }) => {
	const { t } = useAppTranslation()
	const { piiMasking } = useExtensionState()

	const enabled = piiMasking?.enabled === true

	const toggle = useCallback(() => {
		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: { piiMasking: { ...(piiMasking ?? {}), enabled: !enabled } },
		})
	}, [piiMasking, enabled])

	return (
		<StandardTooltip content={enabled ? t("chat:secretMode.on") : t("chat:secretMode.off")}>
			<Button
				variant="ghost"
				size="icon"
				onClick={toggle}
				aria-pressed={enabled}
				data-testid="secret-mode-toggle"
				className={cn("opacity-85", enabled && "text-vscode-charts-green opacity-100", className)}>
				{enabled ? <Shield /> : <ShieldOff />}
			</Button>
		</StandardTooltip>
	)
}
