import React, { useCallback } from "react"
import { Lock, Unlock } from "lucide-react"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { StandardTooltip, Button } from "@src/components/ui"

/**
 * ファイル対応表の切り替え。
 *
 * **目的。** 読んだファイルの伏せ字を保存するかどうかを、設定の画面を開かずに決められる
 * ようにする（`FR-PII-24`）。シークレットモードの隣に置く。
 *
 * **仕組み。** 押すと `piiMasking.fileMapping.enabled` を書き換えて保存する。入にすると、
 * エージェントが読んだファイルの対応を暗号化して残し、起動をまたいでも同じ伏せ字が当たる。
 *
 * **いま入っているかが一目で分かるようにする。** 入っているのに気づかないと、伏せた値が
 * ディスクへ残っていることに気づけない。入っているときを目立たせる。
 */
export const FileMappingToggle: React.FC<{ className?: string }> = ({ className }) => {
	const { t } = useAppTranslation()
	const { piiMasking } = useExtensionState()

	const enabled = piiMasking?.fileMapping?.enabled === true

	const toggle = useCallback(() => {
		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: {
				piiMasking: {
					...(piiMasking ?? {}),
					fileMapping: { ...(piiMasking?.fileMapping ?? {}), enabled: !enabled },
				},
			},
		})
	}, [piiMasking, enabled])

	return (
		<StandardTooltip content={enabled ? t("chat:fileMapping.on") : t("chat:fileMapping.off")}>
			<Button
				variant="ghost"
				size="icon"
				onClick={toggle}
				aria-pressed={enabled}
				data-testid="file-mapping-toggle"
				className={cn("opacity-85", enabled && "text-vscode-charts-green opacity-100", className)}>
				{enabled ? <Lock /> : <Unlock />}
			</Button>
		</StandardTooltip>
	)
}
