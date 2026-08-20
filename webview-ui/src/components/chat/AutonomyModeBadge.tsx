import { useCallback } from "react"
import { Lock, FilePen, Zap, ClipboardList, type LucideIcon } from "lucide-react"

import { type AutonomyMode, nextAutonomyMode } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StandardTooltip } from "@/components/ui"
import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"

const MODE_META: Record<AutonomyMode, { icon: LucideIcon; labelKey: string; className: string }> = {
	manual: { icon: Lock, labelKey: "chat:autonomy.manual", className: "text-vscode-descriptionForeground" },
	autoEdit: { icon: FilePen, labelKey: "chat:autonomy.autoEdit", className: "text-vscode-charts-blue" },
	auto: { icon: Zap, labelKey: "chat:autonomy.auto", className: "text-vscode-charts-yellow" },
	plan: { icon: ClipboardList, labelKey: "chat:autonomy.plan", className: "text-vscode-charts-green" },
}

/**
 * Chat-bar badge showing the current autonomy mode (Claude Code-style permission modes).
 * Click cycles Manual -> Auto-Edit -> Auto. Also switchable via Ctrl+Shift+A and the
 * command palette. Autonomy is user-controlled only; the model can never change it.
 */
export const AutonomyModeBadge = () => {
	const { t } = useAppTranslation()
	const { autonomyMode } = useExtensionState()
	const mode: AutonomyMode = autonomyMode ?? "manual"
	const meta = MODE_META[mode]
	const Icon = meta.icon

	const handleClick = useCallback(() => {
		vscode.postMessage({ type: "setAutonomyMode", autonomyMode: nextAutonomyMode(mode) })
	}, [mode])

	const tooltip = t("chat:autonomy.tooltip", {
		mode: t(meta.labelKey),
		next: t(MODE_META[nextAutonomyMode(mode)].labelKey),
	})

	return (
		<StandardTooltip content={tooltip}>
			<button
				type="button"
				onClick={handleClick}
				data-testid="autonomy-mode-badge"
				className={cn(
					"flex items-center gap-1 px-1.5 h-5 rounded text-xs whitespace-nowrap",
					"border-0 bg-transparent cursor-pointer hover:bg-vscode-toolbar-hoverBackground",
					meta.className,
				)}>
				<Icon className="w-3.5 h-3.5 shrink-0" />
				<span>{t(meta.labelKey)}</span>
			</button>
		</StandardTooltip>
	)
}
