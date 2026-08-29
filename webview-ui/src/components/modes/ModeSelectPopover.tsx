import type React from "react"
import { ChevronDown, X } from "lucide-react"

import type { ModeConfig } from "@openai-agent/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@src/components/ui"

/**
 * 検索文字列でモードを絞り込む。
 *
 * 突き合わせるのは表示名のみ（slug は対象外）。大文字小文字は無視する。
 * 空の検索文字列は「絞り込み無し」。
 */
export function filterModesBySearch(modes: readonly ModeConfig[], searchValue: string): ModeConfig[] {
	if (!searchValue) {
		return [...modes]
	}

	const needle = searchValue.toLowerCase()
	return modes.filter((modeConfig) => modeConfig.name.toLowerCase().includes(needle))
}

export interface ModeSelectPopoverProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** 表示用のモード一覧（ローカルのリネーム適用済み）。 */
	modes: ModeConfig[]
	/** トリガーに出す現在モード名。未解決なら既定の文言にフォールバックする。 */
	currentModeName?: string
	searchValue: string
	onSearchChange: (value: string) => void
	onClearSearch: () => void
	searchInputRef: React.RefObject<HTMLInputElement>
	onSelect: (mode: ModeConfig) => void
}

/** モードを選ぶコンボボックス。絞り込みは名前のみを対象にする。 */
export const ModeSelectPopover = ({
	open,
	onOpenChange,
	modes,
	currentModeName,
	searchValue,
	onSearchChange,
	onClearSearch,
	searchInputRef,
	onSelect,
}: ModeSelectPopoverProps) => {
	const { t } = useAppTranslation()

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="combobox"
					role="combobox"
					aria-expanded={open}
					className="justify-between grow"
					data-testid="mode-select-trigger">
					<div className="truncate">{currentModeName ?? t("prompts:modes.selectMode")}</div>
					<ChevronDown className="opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]">
				<Command>
					<div className="relative">
						<CommandInput
							ref={searchInputRef}
							value={searchValue}
							onValueChange={onSearchChange}
							placeholder={t("prompts:modes.selectMode")}
							className="h-9 mr-4"
							data-testid="mode-search-input"
						/>
						{searchValue.length > 0 && (
							<div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
								<X
									className="text-vscode-input-foreground opacity-50 hover:opacity-100 size-4 p-0.5 cursor-pointer"
									onClick={onClearSearch}
								/>
							</div>
						)}
					</div>
					<CommandList>
						<CommandEmpty>
							{searchValue && <div className="py-2 px-1 text-sm">{t("prompts:modes.noMatchFound")}</div>}
						</CommandEmpty>
						<CommandGroup>
							{filterModesBySearch(modes, searchValue).map((modeConfig) => (
								<CommandItem
									key={modeConfig.slug}
									value={`${modeConfig.name} ${modeConfig.slug}`}
									onSelect={() => onSelect(modeConfig)}
									data-testid={`mode-option-${modeConfig.slug}`}>
									<div className="flex items-center justify-between w-full">
										<span
											style={{
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
												flex: 2,
												minWidth: 0,
											}}>
											{modeConfig.name}
										</span>
										<span
											className="text-foreground"
											style={{
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
												direction: "rtl",
												textAlign: "right",
												flex: 1,
												minWidth: 0,
												marginLeft: "0.5em",
											}}>
											{modeConfig.slug}
										</span>
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
