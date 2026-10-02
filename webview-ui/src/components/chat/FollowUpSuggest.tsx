import { useCallback } from "react"
import { ClipboardCopy } from "lucide-react"

import { Button, StandardTooltip } from "@/components/ui"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { SuggestionItem } from "@openai-agent/types"

interface FollowUpSuggestProps {
	suggestions?: SuggestionItem[]
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	ts: number
}

/**
 * モデルの質問に付いた回答の候補。押すと送信し、右上のボタンは入力欄へ写す。
 *
 * 待ち時間で自動的に選ぶことはしない。自動で答えるのは Autopilot だけで、それは拡張側が
 * 即座に答える（src/core/auto-approval）。
 */
export const FollowUpSuggest = ({ suggestions = [], onSuggestionClick, ts = 1 }: FollowUpSuggestProps) => {
	const { t } = useAppTranslation()

	const handleSuggestionClick = useCallback(
		(suggestion: SuggestionItem, event: React.MouseEvent) => {
			// Pass the suggestion object to the parent component
			// The parent component will handle mode switching if needed
			onSuggestionClick?.(suggestion, event)
		},
		[onSuggestionClick],
	)

	// Don't render if there are no suggestions or no click handler.
	if (!suggestions?.length || !onSuggestionClick) {
		return null
	}

	return (
		<div className="flex mb-2 flex-col h-full gap-2">
			{suggestions.map((suggestion) => (
				<div key={`${suggestion.answer}-${ts}`} className="w-full relative group">
					<Button
						variant="outline"
						className="text-left whitespace-normal break-words w-full h-auto px-3 py-2 justify-start pr-8 rounded-xl"
						onClick={(event) => handleSuggestionClick(suggestion, event)}
						aria-label={suggestion.answer}>
						{suggestion.answer}
					</Button>
					{suggestion.mode && (
						<div className="absolute bottom-0 right-0 text-[10px] text-vscode-badge-foreground pl-1 pr-2.5 pt-0.5 pb-1.5 flex items-center gap-0.5 bg-transparent rounded-xl">
							<span className="codicon codicon-arrow-right" style={{ fontSize: "8px" }} />
							{suggestion.mode}
						</div>
					)}
					<StandardTooltip content={t("chat:followUpSuggest.copyToInput")}>
						<div
							className="absolute cursor-pointer top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-vscode-input-background px-0.5 rounded"
							onClick={(e) => {
								e.stopPropagation()
								// Simulate shift-click by directly calling the handler with shiftKey=true.
								onSuggestionClick?.(suggestion, { ...e, shiftKey: true })
							}}>
							<ClipboardCopy className="w-4" />
						</div>
					</StandardTooltip>
				</div>
			))}
		</div>
	)
}
