import React, { useState, useEffect, useCallback, useRef } from "react"
import { VSCodeCheckbox, VSCodeTextArea, VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { Upload, Download } from "lucide-react"

import { ModeConfig, PromptComponent, ToolGroup } from "@openai-agent/types"

import {
	Mode,
	getRoleDefinition,
	getWhenToUse,
	getDescription,
	getCustomInstructions,
	getAllModes,
	findModeBySlug as findCustomModeBySlug,
	defaultModeSlug,
} from "@agent/modes"

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
import { DeleteModeDialog } from "@src/components/modes/DeleteModeDialog"
import { CreateModeDialog } from "@src/components/modes/CreateModeDialog"
import { ImportModeDialog } from "@src/components/modes/ImportModeDialog"
import { ModeSelectPopover } from "@src/components/modes/ModeSelectPopover"
import {
	availableGroups,
	buildUniqueModeIdentity,
	emptyFieldErrors,
	generateSlug,
	getGroupName,
	toggleGroup,
	validateModeDraft,
	applyLocalRenames,
} from "@src/components/modes/modeFormLogic"
import { useModeFormState } from "@src/components/modes/useModeFormState"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

type ImportModeResult = { type: "importModeResult"; success: boolean; slug?: string; error?: string }

const ModesView = () => {
	const { t } = useAppTranslation()

	const {
		customModePrompts,
		listApiConfigMeta,
		currentApiConfigName,
		mode,
		customInstructions,
		setCustomInstructions,
		customModes,
	} = useExtensionState()

	// Use a local state to track the visually active mode
	// This prevents flickering when switching modes rapidly by:
	// 1. Updating the UI immediately when a mode is clicked
	// 2. Not syncing with the backend mode state (which would cause flickering)
	// 3. Still sending the mode change to the backend for persistence
	const [visualMode, setVisualMode] = useState(mode)

	// Build modes fresh each render so search reflects inline rename updates immediately
	const modes = getAllModes(customModes)

	const [isDialogOpen, setIsDialogOpen] = useState(false)
	const [selectedPromptContent, setSelectedPromptContent] = useState("")
	const [selectedPromptTitle, setSelectedPromptTitle] = useState("")
	const [isToolsEditMode, setIsToolsEditMode] = useState(false)
	const [showConfigMenu, setShowConfigMenu] = useState(false)
	const [isCreateModeDialogOpen, setIsCreateModeDialogOpen] = useState(false)
	const [isExporting, setIsExporting] = useState(false)
	const [isImporting, setIsImporting] = useState(false)
	const [showImportDialog, setShowImportDialog] = useState(false)
	const [importLevel, setImportLevel] = useState<"global" | "project">("project")
	const [hasRulesToExport, setHasRulesToExport] = useState<Record<string, boolean>>({})
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const [modeToDelete, setModeToDelete] = useState<{
		slug: string
		name: string
		source?: string
		rulesFolderPath?: string
	} | null>(null)

	// State for mode selection popover and search
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const searchInputRef = useRef<HTMLInputElement>(null)

	// removed unused local name state (replaced by inline rename UX)

	// Inline rename state for the mode dropdown row
	const [isRenamingMode, setIsRenamingMode] = useState(false)
	const [renameInputValue, setRenameInputValue] = useState("")
	const renameInputRef = useRef<any>(null)

	// Optimistic rename map so search reflects new names immediately
	const [localRenames, setLocalRenames] = useState<Record<string, string>>({})
	// Display list that overlays optimistic names
	const displayModes = applyLocalRenames(modes, localRenames)

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

	const updateCustomMode = useCallback((slug: string, modeConfig: ModeConfig) => {
		/* v8 ignore next -- 到達不能: 呼び出し側 4 箇所はいずれも source を設定済みの ModeConfig を渡す。型では省略可能なので既定は残す */
		const source = modeConfig.source || "global"

		vscode.postMessage({
			type: "updateCustomMode",
			slug,
			modeConfig: {
				...modeConfig,
				source, // Ensure source is set
			},
		})
	}, [])

	// Helper function to find a mode by slug
	const findModeBySlug = useCallback(
		(searchSlug: string, modes: readonly ModeConfig[] | undefined): ModeConfig | undefined => {
			return findCustomModeBySlug(searchSlug, modes)
		},
		[],
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

			// Exit tools edit mode when switching modes
			setIsToolsEditMode(false)
		},
		[visualMode, switchMode],
	)

	// Refs to track latest state/functions for message handler (which has no dependencies)
	const handleModeSwitchRef = useRef(handleModeSwitch)
	const customModesRef = useRef(customModes)
	const switchModeRef = useRef(switchMode)

	// Update refs when dependencies change
	useEffect(() => {
		handleModeSwitchRef.current = handleModeSwitch
	}, [handleModeSwitch])

	useEffect(() => {
		customModesRef.current = customModes
	}, [customModes])

	useEffect(() => {
		switchModeRef.current = switchMode
	}, [switchMode])

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

	// Handler for clearing search input
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

	// Focus rename input when entering rename mode
	useEffect(() => {
		if (isRenamingMode) {
			const id = setTimeout(() => renameInputRef.current?.focus(), 0)
			return () => clearTimeout(id)
		}
	}, [isRenamingMode])

	const handleStartRenameMode = useCallback(() => {
		const customMode = findModeBySlug(visualMode, customModes)
		if (customMode) {
			setIsRenamingMode(true)
			setRenameInputValue(customMode.name)
		}
	}, [visualMode, customModes, findModeBySlug])

	const handleCancelRenameMode = useCallback(() => {
		setIsRenamingMode(false)
		setRenameInputValue("")
	}, [])

	const handleSaveRenameMode = useCallback(() => {
		const customMode = findModeBySlug(visualMode, customModes)
		const trimmed = renameInputValue.trim()
		if (!customMode || !trimmed) {
			setIsRenamingMode(false)
			return
		}
		// Prevent duplicate names against other modes
		const nameTaken = modes.some(
			(m) => m.name.toLowerCase() === trimmed.toLowerCase() && m.slug !== customMode.slug,
		)
		if (nameTaken) {
			// simple guard: do nothing if taken
			return
		}
		updateCustomMode(visualMode, {
			...customMode,
			name: trimmed,
			source: customMode.source || "global",
		})
		// Optimistically reflect rename in UI/search immediately
		setLocalRenames((prev) => ({ ...prev, [visualMode]: trimmed }))
		setIsRenamingMode(false)
	}, [visualMode, customModes, renameInputValue, modes, updateCustomMode, findModeBySlug])

	// Helper function to get current mode's config
	const getCurrentMode = useCallback((): ModeConfig | undefined => {
		const findMode = (m: ModeConfig): boolean => m.slug === visualMode
		return customModes?.find(findMode) || modes.find(findMode)
	}, [visualMode, customModes, modes])

	// Check if the current mode has rules to export
	const checkRulesDirectory = useCallback((slug: string) => {
		vscode.postMessage({
			type: "checkRulesDirectory",
			slug: slug,
		})
	}, [])

	// Check rules directory when mode changes
	useEffect(() => {
		const currentMode = getCurrentMode()
		if (currentMode?.slug && hasRulesToExport[currentMode.slug] === undefined) {
			checkRulesDirectory(currentMode.slug)
		}
	}, [getCurrentMode, checkRulesDirectory, hasRulesToExport])

	// State for create mode dialog
	// 作成フォームの下書き 8 個とエラー 5 個は常に一緒に初期化・破棄されるので所有者を 1 つにする
	const { draft, setField, patch, errors, setErrors, reset: resetFormState } = useModeFormState()

	// Ensure import dialog defaults to "project" each open
	useEffect(() => {
		if (showImportDialog) {
			setImportLevel("project")
		}
	}, [showImportDialog])

	// Handler for name changes
	const handleNameChange = useCallback(
		(name: string) => {
			patch({ name, slug: generateSlug(name) })
		},
		[patch],
	)

	const handleCreateMode = useCallback(() => {
		const result = validateModeDraft(draft)

		// Clear previous errors (and surface the new ones in the same pass)
		setErrors(result.ok ? emptyFieldErrors : result.errors)

		if (!result.ok) {
			return
		}

		updateCustomMode(draft.slug, result.mode)
		// Immediately select the newly created mode in the UI
		setVisualMode(draft.slug)
		switchMode(draft.slug)
		setIsCreateModeDialogOpen(false)
		resetFormState()
	}, [draft, setErrors, resetFormState, switchMode, updateCustomMode])

	/** 取り込みを開始する（実行中の二重送信は無視する）。 */
	const handleImportMode = useCallback(() => {
		/* v8 ignore next 3 -- 到達不能: 唯一の呼び出し元である取り込みボタンが isImporting のとき disabled になるため、実行中に再入しない */
		if (isImporting) {
			return
		}

		setIsImporting(true)
		vscode.postMessage({ type: "importMode", source: importLevel })
	}, [isImporting, importLevel])

	const openCreateModeDialog = useCallback(() => {
		// 前回の下書きを捨ててから初期名を入れる。順序が逆だと（以前は開いたことを
		// 見張る effect が後から走っていたため）初期名がその場で消えていた。
		resetFormState()
		const { name, slug } = buildUniqueModeIdentity(modes, "New Custom Mode")
		patch({ name, slug })
		setIsCreateModeDialogOpen(true)
	}, [modes, patch, resetFormState])

	// Handler for group checkbox changes
	const handleGroupChange = useCallback(
		(group: ToolGroup, isCustomMode: boolean, customMode: ModeConfig | undefined) =>
			(e: Event | React.FormEvent<HTMLElement>) => {
				/* v8 ignore next -- 到達不能: このハンドラを持つチェックボックスはカスタムモードのときだけ描画される。組み込みモードへの防御は残す */
				if (!isCustomMode) return // Prevent changes to built-in modes
				const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
				const newGroups = toggleGroup(customMode?.groups || [], group, target.checked)
				if (customMode) {
					const source = customMode.source || "global"

					updateCustomMode(customMode.slug, {
						...customMode,
						groups: newGroups,
						source,
					})
				}
			},
		[updateCustomMode],
	)

	// Handle clicks outside the config menu
	useEffect(() => {
		const handleClickOutside = () => {
			if (showConfigMenu) {
				setShowConfigMenu(false)
			}
		}

		document.addEventListener("click", handleClickOutside)
		return () => document.removeEventListener("click", handleClickOutside)
	}, [showConfigMenu])

	// Use a ref to store the current modeToDelete value
	const modeToDeleteRef = useRef(modeToDelete)

	// Update the ref whenever modeToDelete changes
	useEffect(() => {
		modeToDeleteRef.current = modeToDelete
	}, [modeToDelete])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "systemPrompt") {
				if (message.text) {
					setSelectedPromptContent(message.text)
					setSelectedPromptTitle(`System Prompt (${message.mode} mode)`)
					setIsDialogOpen(true)
				}
			} else if (message.type === "exportModeResult") {
				setIsExporting(false)

				if (!message.success) {
					// Show error message
					console.error("Failed to export mode:", message.error)
				}
			} else if (message.type === "importModeResult") {
				setIsImporting(false)
				setShowImportDialog(false)

				if (message.success) {
					const { slug } = message as ImportModeResult
					if (slug) {
						// Try switching using the freshest mode list available
						const all = getAllModes(customModesRef.current)
						const importedMode = all.find((m) => m.slug === slug)
						if (importedMode) {
							handleModeSwitchRef.current(importedMode)
						} else {
							// Fallback: slug not yet in state (race condition) - select default mode
							setVisualMode(defaultModeSlug)
							switchModeRef.current?.(defaultModeSlug)
						}
					}
				} else {
					// Only log error if it's not a cancellation
					if (message.error !== "cancelled") {
						console.error("Failed to import mode:", message.error)
					}
				}
				// Note: Auto-select after import will be handled by PR #9003
			} else if (message.type === "checkRulesDirectoryResult") {
				setHasRulesToExport((prev) => ({
					...prev,
					[message.slug]: message.hasContent,
				}))
			} else if (message.type === "deleteCustomModeCheck") {
				// Handle the check response
				// Use the ref to get the current modeToDelete value
				const currentModeToDelete = modeToDeleteRef.current
				if (message.slug && currentModeToDelete && currentModeToDelete.slug === message.slug) {
					setModeToDelete({
						...currentModeToDelete,
						rulesFolderPath: message.rulesFolderPath,
					})
					setShowDeleteConfirm(true)
				}
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [checkRulesDirectory, switchMode])

	const handleAgentReset = (
		modeSlug: string,
		type: "roleDefinition" | "description" | "whenToUse" | "customInstructions",
	) => {
		// Only reset for built-in modes。対象フィールドを消すだけでなく残りも scrub する
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
					<div onClick={(e) => e.stopPropagation()} className="flex justify-between items-center mb-3">
						<h3 className="text-[1.25em] font-semibold text-vscode-foreground mt-4 mb-2">
							{t("prompts:modes.title")}
						</h3>
						<div className="flex gap-2">
							<div className="relative inline-block">
								<StandardTooltip content={t("prompts:modes.editModesConfig")}>
									<Button
										variant="ghost"
										size="icon"
										className="flex"
										onClick={(e: React.MouseEvent) => {
											e.preventDefault()
											e.stopPropagation()
											setShowConfigMenu((prev) => !prev)
										}}
										onBlur={() => {
											// Add slight delay to allow menu item clicks to register
											setTimeout(() => setShowConfigMenu(false), 200)
										}}>
										<span className="codicon codicon-json"></span>
									</Button>
								</StandardTooltip>
								{showConfigMenu && (
									<div
										onClick={(e) => e.stopPropagation()}
										onMouseDown={(e) => e.stopPropagation()}
										className="absolute top-full right-0 w-[200px] mt-1 bg-vscode-editor-background border border-vscode-input-border rounded shadow-md z-[1000]">
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openCustomModesSettings",
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editGlobalModes")}
										</div>
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm border-t border-vscode-input-border"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openFile",
													text: "./.agentmodes",
													values: {
														create: true,
														content: JSON.stringify({ customModes: [] }, null, 2),
													},
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editProjectModes")}
										</div>
									</div>
								)}
							</div>
							<StandardTooltip content={t("prompts:modes.importMode")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setShowImportDialog(true)}
									disabled={isImporting}
									title={t("prompts:modes.importMode")}
									data-testid="import-mode-toolbar-button">
									<Download className="h-4 w-4" />
								</Button>
							</StandardTooltip>
						</div>
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
						{isRenamingMode ? (
							<>
								<VSCodeTextField
									ref={renameInputRef}
									value={renameInputValue}
									onInput={(e: unknown) => {
										const target = e as { target: { value: string } }
										setRenameInputValue(target.target.value)
									}}
									className="grow"
									placeholder={t("prompts:createModeDialog.name.placeholder")}
								/>
								<StandardTooltip content={t("settings:common.save")}>
									<Button
										variant="ghost"
										size="icon"
										disabled={!renameInputValue.trim()}
										onClick={handleSaveRenameMode}
										data-testid="save-mode-rename-button">
										<span className="codicon codicon-check" />
									</Button>
								</StandardTooltip>
								<StandardTooltip content={t("settings:common.cancel")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={handleCancelRenameMode}
										data-testid="cancel-mode-rename-button">
										<span className="codicon codicon-close" />
									</Button>
								</StandardTooltip>
							</>
						) : (
							<>
								<ModeSelectPopover
									open={open}
									onOpenChange={onOpenChange}
									modes={displayModes}
									currentModeName={localRenames[visualMode] ?? getCurrentMode()?.name}
									searchValue={searchValue}
									onSearchChange={setSearchValue}
									onClearSearch={onClearSearch}
									searchInputRef={searchInputRef}
									onSelect={handleSelectMode}
								/>

								{/* New mode (+) moved here from the top bar */}
								<StandardTooltip content={t("prompts:modes.createNewMode")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={openCreateModeDialog}
										data-testid="add-mode-button">
										<span className="codicon codicon-add" />
									</Button>
								</StandardTooltip>

								{/* Edit (rename) mode - only enabled for custom modes */}
								<StandardTooltip content={t("settings:providers.renameProfile")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={handleStartRenameMode}
										data-testid="rename-mode-button"
										disabled={!findModeBySlug(visualMode, customModes)}>
										<span className="codicon codicon-edit" />
									</Button>
								</StandardTooltip>

								{/* Delete mode - disabled for built-in modes */}
								<StandardTooltip content={t("prompts:createModeDialog.deleteMode")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											const customMode = findModeBySlug(visualMode, customModes)
											if (customMode) {
												setModeToDelete({
													slug: customMode.slug,
													name: customMode.name,
													source: customMode.source || "global",
												})
												vscode.postMessage({
													type: "deleteCustomMode",
													slug: customMode.slug,
													checkOnly: true,
												})
											}
										}}
										data-testid="delete-mode-button"
										disabled={!findModeBySlug(visualMode, customModes)}>
										<span className="codicon codicon-trash" />
									</Button>
								</StandardTooltip>

								{/* Export mode (kept here to the right of the dropdown) */}
								<StandardTooltip content={t("prompts:exportMode.title")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											const currentMode = getCurrentMode()
											if (currentMode?.slug && !isExporting) {
												setIsExporting(true)
												vscode.postMessage({
													type: "exportMode",
													slug: currentMode.slug,
												})
											}
										}}
										disabled={isExporting}
										title={t("prompts:exportMode.title")}
										data-testid="export-mode-toolbar-button">
										<Upload className="h-4 w-4" />
									</Button>
								</StandardTooltip>
							</>
						)}
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
						{!findModeBySlug(visualMode, customModes) && (
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
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:roleDefinition.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.roleDefinition ?? prompt?.roleDefinition ?? getRoleDefinition(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									roleDefinition: value.trim() || "",
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									roleDefinition: value.trim() || undefined,
								})
							}
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
						{!findModeBySlug(visualMode, customModes) && (
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
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:description.description")}
					</div>
					<VSCodeTextField
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.description ?? prompt?.description ?? getDescription(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									description: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									description: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-description-textfield`}
					/>
				</div>

				{/* When to Use section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:whenToUse.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
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
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:whenToUse.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.whenToUse ?? prompt?.whenToUse ?? getWhenToUse(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									whenToUse: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									whenToUse: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						rows={4}
						data-testid={`${getCurrentMode()?.slug || "code"}-when-to-use-textarea`}
					/>
				</div>

				{/* Mode settings */}
				<>
					{/* Show tools for all modes */}
					<div className="mb-4">
						<div className="flex justify-between items-center mb-1">
							<div className="font-bold">{t("prompts:tools.title")}</div>
							{findModeBySlug(visualMode, customModes) && (
								<StandardTooltip
									content={
										isToolsEditMode ? t("prompts:tools.doneEditing") : t("prompts:tools.editTools")
									}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => setIsToolsEditMode(!isToolsEditMode)}>
										<span
											className={`codicon codicon-${isToolsEditMode ? "check" : "edit"}`}></span>
									</Button>
								</StandardTooltip>
							)}
						</div>
						{!findModeBySlug(visualMode, customModes) && (
							<div className="text-sm text-vscode-descriptionForeground mb-2">
								{t("prompts:tools.builtInModesText")}
							</div>
						)}
						{isToolsEditMode && findModeBySlug(visualMode, customModes) ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
								{availableGroups.map((group) => {
									// このグリッドはカスタムモードのときだけ描画される。
									const customMode = findModeBySlug(visualMode, customModes)
									const isGroupEnabled = customMode?.groups?.some((g) => getGroupName(g) === group)

									return (
										<VSCodeCheckbox
											key={group}
											checked={isGroupEnabled}
											onChange={handleGroupChange(group, Boolean(customMode), customMode)}
											disabled={!customMode}>
											{t(`prompts:tools.toolNames.${group}`)}
											{group === "edit" && (
												<div className="text-xs text-vscode-descriptionForeground mt-0.5">
													{t("prompts:tools.allowedFiles")}{" "}
													{(() => {
														const currentMode = getCurrentMode()
														const editGroup = currentMode?.groups?.find(
															(g) =>
																Array.isArray(g) && g[0] === "edit" && g[1]?.fileRegex,
														)
														if (!Array.isArray(editGroup)) return t("prompts:allFiles")
														return editGroup[1].description || `/${editGroup[1].fileRegex}/`
													})()}
												</div>
											)}
										</VSCodeCheckbox>
									)
								})}
							</div>
						) : (
							<div className="text-sm text-vscode-foreground mb-2 leading-relaxed">
								{(() => {
									const currentMode = getCurrentMode()
									const enabledGroups = currentMode?.groups || []

									// If there are no enabled groups, display translated "None"
									if (enabledGroups.length === 0) {
										return t("prompts:tools.noTools")
									}

									return enabledGroups
										.map((group) => {
											const groupName = getGroupName(group)
											const displayName = t(`prompts:tools.toolNames.${groupName}`)
											if (Array.isArray(group) && group[1]?.fileRegex) {
												const description = group[1].description || `/${group[1].fileRegex}/`
												return `${displayName} (${description})`
											}
											return displayName
										})
										.join(", ")
								})()}
							</div>
						)}
					</div>
				</>

				{/* Role definition for both built-in and custom modes */}
				<div className="mb-2">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:customInstructions.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
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
						)}
					</div>
					<div className="text-[13px] text-vscode-descriptionForeground mb-2">
						{t("prompts:customInstructions.description", {
							modeName: getCurrentMode()?.name || "Code",
						})}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return (
								customMode?.customInstructions ??
								prompt?.customInstructions ??
								getCustomInstructions(visualMode, customModes)
							)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									// Preserve empty string; only treat null/undefined as unset
									customInstructions: value ?? undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								const existingPrompt = customModePrompts?.[visualMode] as PromptComponent
								updateAgentPrompt(visualMode, {
									...existingPrompt,
									customInstructions: value.trim() || undefined,
								})
							}
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

			{isCreateModeDialogOpen && (
				<CreateModeDialog
					draft={draft}
					errors={errors}
					setField={setField}
					onNameChange={handleNameChange}
					onCancel={() => setIsCreateModeDialogOpen(false)}
					onCreate={handleCreateMode}
				/>
			)}

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

			{/* Import Mode Dialog */}
			{showImportDialog && (
				<ImportModeDialog
					level={importLevel}
					onLevelChange={setImportLevel}
					isImporting={isImporting}
					onCancel={() => setShowImportDialog(false)}
					onImport={handleImportMode}
				/>
			)}

			{/* Delete Mode Confirmation Dialog */}
			<DeleteModeDialog
				open={showDeleteConfirm}
				onOpenChange={setShowDeleteConfirm}
				modeToDelete={modeToDelete}
				onConfirm={() => {
					if (modeToDelete) {
						vscode.postMessage({
							type: "deleteCustomMode",
							slug: modeToDelete.slug,
						})
						setShowDeleteConfirm(false)
						setModeToDelete(null)
					}
				}}
			/>
		</div>
	)
}

export default ModesView
