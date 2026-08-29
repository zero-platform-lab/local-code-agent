import { useState, useEffect, useCallback, useRef } from "react"
import { VSCodeTextArea, VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"

import { ModeConfig, PromptComponent } from "@openai-agent/types"

import { Mode, getRoleDefinition, getWhenToUse, getDescription, getCustomInstructions, getAllModes } from "@agent/modes"

import { vscode } from "@src/utils/vscode"
import { buildPromptOverrideForEdit, buildPromptOverrideForReset } from "./modePromptOverrides"
import { buildDocLink } from "@src/utils/docLinks"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Section } from "@src/components/settings/Section"
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StandardTooltip,
} from "@src/components/ui"
import { ModeSelectPopover } from "@src/components/modes/ModeSelectPopover"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

/**
 * モード設定画面。
 *
 * 組み込みモード（code / research）の文面上書き（customModePrompts）を編集する。
 * かつてはカスタムモードの作成・削除・入出力もここにあったが、機構ごと撤去した。
 */
const ModesView = () => {
	const { t } = useAppTranslation()

	const {
		customModePrompts,
		listApiConfigMeta,
		currentApiConfigName,
		mode,
		customInstructions,
		setCustomInstructions,
	} = useExtensionState()

	// Use a local state to track the visually active mode
	// This prevents flickering when switching modes rapidly by:
	// 1. Updating the UI immediately when a mode is clicked
	// 2. Not syncing with the backend mode state (which would cause flickering)
	// 3. Still sending the mode change to the backend for persistence
	const [visualMode, setVisualMode] = useState(mode)

	const modes = getAllModes()

	const [isDialogOpen, setIsDialogOpen] = useState(false)
	const [selectedPromptContent, setSelectedPromptContent] = useState("")
	const [selectedPromptTitle, setSelectedPromptTitle] = useState("")

	// State for mode selection popover and search
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const searchInputRef = useRef<HTMLInputElement>(null)

	// Direct update functions
	const updateAgentPrompt = useCallback(
		(mode: Mode, promptData: PromptComponent) => {
			// 組み込み既定と同じ値を上書きとして保存しない（scrub は純関数側）。
			vscode.postMessage({
				type: "updatePrompt",
				promptMode: mode,
				customPrompt: buildPromptOverrideForEdit(
					mode,
					customModePrompts?.[mode] as PromptComponent,
					promptData,
				),
			})
		},
		[customModePrompts],
	)

	const switchMode = useCallback((slug: string) => {
		vscode.postMessage({
			type: "mode",
			text: slug,
		})
	}, [])

	// Handle mode switching with explicit state initialization
	const handleModeSwitch = useCallback(
		(modeConfig: ModeConfig) => {
			if (modeConfig.slug === visualMode) return // Prevent unnecessary updates

			// Immediately update visual state for instant feedback
			setVisualMode(modeConfig.slug)

			// Then send the mode change message to the backend
			switchMode(modeConfig.slug)
		},
		[visualMode, switchMode],
	)

	// Sync visualMode with backend mode changes to prevent desync
	useEffect(() => {
		setVisualMode(mode)
	}, [mode])

	// Handler for popover open state change
	const onOpenChange = useCallback((open: boolean) => {
		setOpen(open)
		// Reset search when closing the popover
		if (!open) {
			setTimeout(() => setSearchValue(""), 100)
		}
	}, [])

	// Use the shared ESC key handler hook
	useEscapeKey(open, () => setOpen(false))

	/** ポップオーバーからモードを選んだとき。 */
	const handleSelectMode = useCallback(
		(modeConfig: ModeConfig) => {
			handleModeSwitch(modeConfig)
			setOpen(false)
		},
		[handleModeSwitch],
	)

	const onClearSearch = useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	// Helper function to get current mode's config
	const getCurrentMode = useCallback((): ModeConfig | undefined => {
		return modes.find((m) => m.slug === visualMode)
	}, [visualMode, modes])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "systemPrompt") {
				if (message.text) {
					setSelectedPromptContent(message.text)
					setSelectedPromptTitle(`System Prompt (${message.mode} mode)`)
					setIsDialogOpen(true)
				}
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const handleAgentReset = (
		modeSlug: string,
		type: "roleDefinition" | "description" | "whenToUse" | "customInstructions",
	) => {
		// 対象フィールドを消すだけでなく残りも scrub する
		// （事前投入された既定が上書きとして保存されるのを防ぐ）。
		vscode.postMessage({
			type: "updatePrompt",
			promptMode: modeSlug,
			customPrompt: buildPromptOverrideForReset(modeSlug, customModePrompts?.[modeSlug] as PromptComponent, type),
		})
	}

	return (
		<div>
			<Section>
				<div>
					<div className="flex justify-between items-center mb-3">
						<h3 className="text-[1.25em] font-semibold text-vscode-foreground mt-4 mb-2">
							{t("prompts:modes.title")}
						</h3>
					</div>

					<div className="text-sm text-vscode-descriptionForeground mb-3">
						<Trans i18nKey="prompts:modes.createModeHelpText">
							<VSCodeLink
								href={buildDocLink("basic-usage/using-modes", "prompts_view_modes")}
								style={{ display: "inline" }}
								aria-label="Learn about using modes"></VSCodeLink>
							<VSCodeLink
								href={buildDocLink("features/custom-modes", "prompts_view_modes")}
								style={{ display: "inline" }}
								aria-label="Learn about customizing modes"></VSCodeLink>
						</Trans>
					</div>

					<div className="flex items-center gap-1 mb-3">
						<ModeSelectPopover
							open={open}
							onOpenChange={onOpenChange}
							modes={modes}
							currentModeName={getCurrentMode()?.name}
							searchValue={searchValue}
							onSearchChange={setSearchValue}
							onClearSearch={onClearSearch}
							searchInputRef={searchInputRef}
							onSelect={handleSelectMode}
						/>
					</div>

					{/* API Configuration - Moved Here */}
					<div className="mb-3">
						<div className="font-bold mb-1">{t("prompts:apiConfiguration.title")}</div>
						<div className="text-sm text-vscode-descriptionForeground mb-2">
							{t("prompts:apiConfiguration.select")}
						</div>
						<div className="mb-2">
							<Select
								value={currentApiConfigName}
								onValueChange={(value) => {
									vscode.postMessage({
										type: "loadApiConfiguration",
										text: value,
									})
								}}>
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									{(listApiConfigMeta || []).map((config) => (
										<SelectItem key={config.id} value={config.name}>
											{config.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				{/* Role Definition section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:roleDefinition.title")}</div>
						<StandardTooltip content={t("prompts:roleDefinition.resetToDefault")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode?.slug) {
										handleAgentReset(currentMode.slug, "roleDefinition")
									}
								}}
								data-testid="role-definition-reset">
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:roleDefinition.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return prompt?.roleDefinition ?? getRoleDefinition(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateAgentPrompt(visualMode, {
								roleDefinition: value.trim() || undefined,
							})
						}}
						className="w-full"
						rows={5}
						data-testid={`${getCurrentMode()?.slug || "code"}-prompt-textarea`}
					/>
				</div>

				{/* Description section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:description.title")}</div>
						<StandardTooltip content={t("prompts:description.resetToDefault")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode?.slug) {
										handleAgentReset(currentMode.slug, "description")
									}
								}}
								data-testid="description-reset">
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:description.description")}
					</div>
					<VSCodeTextField
						value={(() => {
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return prompt?.description ?? getDescription(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateAgentPrompt(visualMode, {
								description: value.trim() || undefined,
							})
						}}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-description-textfield`}
					/>
				</div>

				{/* When to Use section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:whenToUse.title")}</div>
						<StandardTooltip content={t("prompts:whenToUse.resetToDefault")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode?.slug) {
										handleAgentReset(currentMode.slug, "whenToUse")
									}
								}}
								data-testid="when-to-use-reset">
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:whenToUse.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return prompt?.whenToUse ?? getWhenToUse(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateAgentPrompt(visualMode, {
								whenToUse: value.trim() || undefined,
							})
						}}
						className="w-full"
						rows={4}
						data-testid={`${getCurrentMode()?.slug || "code"}-when-to-use-textarea`}
					/>
				</div>

				{/* Available tool groups (read-only; groups are fixed per built-in mode) */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:tools.title")}</div>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:tools.builtInModesText")}
					</div>
					<div className="text-sm text-vscode-foreground mb-2 leading-relaxed">
						{(() => {
							const enabledGroups = getCurrentMode()?.groups || []

							/* v8 ignore next 3 -- 到達不能: 組み込みモードは必ずグループを持つ。防御として残す */
							if (enabledGroups.length === 0) {
								return t("prompts:tools.noTools")
							}

							return enabledGroups.map((group) => t(`prompts:tools.toolNames.${group}`)).join(", ")
						})()}
					</div>
				</div>

				{/* Mode-specific custom instructions */}
				<div className="mb-2">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:customInstructions.title")}</div>
						<StandardTooltip content={t("prompts:customInstructions.resetToDefault")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode?.slug) {
										handleAgentReset(currentMode.slug, "customInstructions")
									}
								}}
								data-testid="custom-instructions-reset">
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-[13px] text-vscode-descriptionForeground mb-2">
						{t("prompts:customInstructions.description", {
							modeName: getCurrentMode()?.name || "Code",
						})}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return prompt?.customInstructions ?? getCustomInstructions(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const existingPrompt = customModePrompts?.[visualMode] as PromptComponent
							updateAgentPrompt(visualMode, {
								...existingPrompt,
								customInstructions: value.trim() || undefined,
							})
						}}
						rows={10}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-custom-instructions-textarea`}
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:customInstructions.loadFromFile"
							values={{
								mode: getCurrentMode()?.name || "Code",
								slug: getCurrentMode()?.slug || "code",
							}}
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() => {
											const currentMode = getCurrentMode()
											if (!currentMode) return

											// Open or create an empty file
											vscode.postMessage({
												type: "openFile",
												text: `./.agent/rules-${currentMode.slug}/rules.md`,
												values: {
													create: true,
													content: "",
												},
											})
										}}
									/>
								),
								"0": (
									<VSCodeLink
										href={buildDocLink(
											"features/custom-instructions#global-rules-directory",
											"prompts_mode_specific_global_rules",
										)}
										style={{ display: "inline" }}
										aria-label="Learn about global custom instructions for modes"
									/>
								),
							}}
						/>
					</div>
				</div>

				<div className="pb-4 border-b border-vscode-input-border">
					<div className="flex gap-2 mb-4">
						<Button
							variant="primary"
							onClick={() => {
								const currentMode = getCurrentMode()
								if (currentMode) {
									vscode.postMessage({
										type: "getSystemPrompt",
										mode: currentMode.slug,
									})
								}
							}}
							data-testid="preview-prompt-button">
							{t("prompts:systemPrompt.preview")}
						</Button>
						<StandardTooltip content={t("prompts:systemPrompt.copy")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode) {
										vscode.postMessage({
											type: "copySystemPrompt",
											mode: currentMode.slug,
										})
									}
								}}
								data-testid="copy-prompt-button">
								<span className="codicon codicon-copy"></span>
							</Button>
						</StandardTooltip>
					</div>
				</div>

				<div className="pb-5">
					<h3 className="text-vscode-foreground mb-3">{t("prompts:globalCustomInstructions.title")}</h3>

					<div className="text-sm text-vscode-descriptionForeground mb-2">
						<Trans i18nKey="prompts:globalCustomInstructions.description">
							<VSCodeLink
								href={buildDocLink(
									"features/custom-instructions#setting-up-global-rules",
									"prompts_global_custom_instructions",
								)}
								style={{ display: "inline" }}
								aria-label="Learn more about global custom instructions"></VSCodeLink>
						</Trans>
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={customInstructions || ""}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							setCustomInstructions(value ?? undefined)
							vscode.postMessage({
								type: "customInstructions",
								text: value ?? undefined,
							})
						}}
						rows={4}
						className="w-full"
						data-testid="global-custom-instructions-textarea"
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:globalCustomInstructions.loadFromFile"
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() =>
											vscode.postMessage({
												type: "openFile",
												text: "./.agent/rules/rules.md",
												values: {
													create: true,
													content: "",
												},
											})
										}
									/>
								),
								"0": (
									<VSCodeLink
										href={buildDocLink(
											"features/custom-instructions#setting-up-global-rules",
											"prompts_global_rules",
										)}
										style={{ display: "inline" }}
										aria-label="Learn about setting up global custom instructions"
									/>
								),
							}}
						/>
					</div>
				</div>
			</Section>

			{isDialogOpen && (
				<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
					<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
						<div className="flex-1 p-5 overflow-y-auto min-h-0">
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setIsDialogOpen(false)}
								className="absolute top-5 right-5">
								<span className="codicon codicon-close"></span>
							</Button>
							<h2 className="mb-4">
								{/* v8 ignore next 4 -- 到達不能: このダイアログを開く systemPrompt メッセージが必ずタイトルも設定するため、既定文言側は踏まない */}
								{selectedPromptTitle ||
									t("prompts:systemPrompt.title", {
										modeName: getCurrentMode()?.name || "Code",
									})}
							</h2>
							<pre className="p-2 whitespace-pre-wrap break-words font-mono text-vscode-editor-font-size text-vscode-editor-foreground bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded overflow-y-auto">
								{selectedPromptContent}
							</pre>
						</div>
						<div className="flex justify-end p-3 px-5 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
							<Button variant="secondary" onClick={() => setIsDialogOpen(false)}>
								{t("prompts:createModeDialog.close")}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

export default ModesView
