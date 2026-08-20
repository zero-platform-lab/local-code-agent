import { HTMLAttributes } from "react"
import React from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"
import { FoldVertical } from "lucide-react"

import { supportPrompt } from "@agent/support-prompt"

import { cn } from "@/lib/utils"
import {
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
	Button,
	StandardTooltip,
} from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { vscode } from "@/utils/vscode"
import {
	DEFAULT_MAX_GIT_STATUS_FILES,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	DEFAULT_MAX_WORKSPACE_FILES,
} from "@openai-agent/types"
import { DEFAULT_MAX_DIAGNOSTIC_MESSAGES, fromSliderValue, isUnlimited, toSliderValue } from "./diagnosticMessagesLimit"

type ContextManagementSettingsProps = HTMLAttributes<HTMLDivElement> & {
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	listApiConfigMeta: any[]
	maxOpenTabsContext: number
	maxWorkspaceFiles: number
	showAgentIgnoredFiles?: boolean
	enableSubfolderRules?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
	profileThresholds?: Record<string, number>
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	writeDelayMs: number
	includeCurrentTime?: boolean
	includeCurrentCost?: boolean
	maxGitStatusFiles?: number
	customSupportPrompts: Record<string, string | undefined>
	setCustomSupportPrompts: (prompts: Record<string, string | undefined>) => void
	setCachedStateField: SetCachedStateField<
		| "autoCondenseContext"
		| "autoCondenseContextPercent"
		| "maxOpenTabsContext"
		| "maxWorkspaceFiles"
		| "showAgentIgnoredFiles"
		| "enableSubfolderRules"
		| "maxImageFileSize"
		| "maxTotalImageSize"
		| "profileThresholds"
		| "includeDiagnosticMessages"
		| "maxDiagnosticMessages"
		| "writeDelayMs"
		| "includeCurrentTime"
		| "includeCurrentCost"
		| "maxGitStatusFiles"
	>
}

export const ContextManagementSettings = ({
	autoCondenseContext,
	autoCondenseContextPercent,
	listApiConfigMeta,
	maxOpenTabsContext,
	maxWorkspaceFiles,
	showAgentIgnoredFiles,
	enableSubfolderRules,
	setCachedStateField,
	maxImageFileSize,
	maxTotalImageSize,
	profileThresholds = {},
	includeDiagnosticMessages,
	maxDiagnosticMessages,
	writeDelayMs,
	includeCurrentTime,
	includeCurrentCost,
	maxGitStatusFiles,
	customSupportPrompts,
	setCustomSupportPrompts,
	className,
	...props
}: ContextManagementSettingsProps) => {
	const { t } = useAppTranslation()
	const [selectedThresholdProfile, setSelectedThresholdProfile] = React.useState<string>("default")

	// Helper function to get the CONDENSE prompt value
	const getCondensePromptValue = (): string => {
		return supportPrompt.get(customSupportPrompts, "CONDENSE")
	}

	// Helper function to update the CONDENSE prompt
	const updateCondensePrompt = (value: string | undefined) => {
		const updatedPrompts = { ...customSupportPrompts }
		/* v8 ignore next 2 -- 到達不能: 入力ハンドラは常に文字列を渡し、削除はリセットボタン（handleCondenseReset）が担う。防御は残す */
		if (value === undefined) {
			delete updatedPrompts["CONDENSE"]
		} else {
			updatedPrompts["CONDENSE"] = value
		}
		setCustomSupportPrompts(updatedPrompts)
	}

	// Helper function to reset the CONDENSE prompt to default
	const handleCondenseReset = () => {
		const updatedPrompts = { ...customSupportPrompts }
		delete updatedPrompts["CONDENSE"]
		setCustomSupportPrompts(updatedPrompts)
	}

	// Helper function to get the current threshold value based on selected profile
	const getCurrentThresholdValue = () => {
		if (selectedThresholdProfile === "default") {
			return autoCondenseContextPercent
		}
		const profileThreshold = profileThresholds[selectedThresholdProfile]
		if (profileThreshold === undefined || profileThreshold === -1) {
			return autoCondenseContextPercent // Use default if profile not configured or set to -1
		}
		return profileThreshold
	}

	// Helper function to handle threshold changes
	const handleThresholdChange = (value: number) => {
		if (selectedThresholdProfile === "default") {
			setCachedStateField("autoCondenseContextPercent", value)
		} else {
			const newThresholds = {
				...profileThresholds,
				[selectedThresholdProfile]: value,
			}

			setCachedStateField("profileThresholds", newThresholds)
			vscode.postMessage({ type: "updateSettings", updatedSettings: { profileThresholds: newThresholds } })
		}
	}
	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader description={t("settings:contextManagement.description")}>
				{t("settings:sections.contextManagement")}
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="context-open-tabs"
					section="contextManagement"
					label={t("settings:contextManagement.openTabs.label")}>
					<span className="block mb-1">{t("settings:contextManagement.openTabs.label")}</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={500}
							step={1}
							value={[maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT]}
							onValueChange={([value]) => setCachedStateField("maxOpenTabsContext", value)}
							data-testid="open-tabs-limit-slider"
						/>
						<span className="w-10">{maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.openTabs.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-workspace-files"
					section="contextManagement"
					label={t("settings:contextManagement.workspaceFiles.label")}>
					<span className="block mb-1">{t("settings:contextManagement.workspaceFiles.label")}</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={500}
							step={1}
							value={[maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES]}
							onValueChange={([value]) => setCachedStateField("maxWorkspaceFiles", value)}
							data-testid="workspace-files-limit-slider"
						/>
						<span className="w-10">{maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.workspaceFiles.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-git-status-files"
					section="contextManagement"
					label={t("settings:contextManagement.maxGitStatusFiles.label")}>
					<span className="block mb-1">{t("settings:contextManagement.maxGitStatusFiles.label")}</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={50}
							step={1}
							value={[maxGitStatusFiles ?? DEFAULT_MAX_GIT_STATUS_FILES]}
							onValueChange={([value]) => setCachedStateField("maxGitStatusFiles", value)}
							data-testid="max-git-status-files-slider"
						/>
						<span className="w-10">{maxGitStatusFiles ?? DEFAULT_MAX_GIT_STATUS_FILES}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.maxGitStatusFiles.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-show-agentignored-files"
					section="contextManagement"
					label={t("settings:contextManagement.agentignore.label")}>
					<VSCodeCheckbox
						checked={showAgentIgnoredFiles}
						onChange={(e: any) => setCachedStateField("showAgentIgnoredFiles", e.target.checked)}
						data-testid="show-agentignored-files-checkbox">
						<label className="block mb-1">{t("settings:contextManagement.agentignore.label")}</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.agentignore.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-enable-subfolder-rules"
					section="contextManagement"
					label={t("settings:contextManagement.enableSubfolderRules.label")}>
					<VSCodeCheckbox
						checked={enableSubfolderRules}
						onChange={(e: any) => setCachedStateField("enableSubfolderRules", e.target.checked)}
						data-testid="enable-subfolder-rules-checkbox">
						<label className="block mb-1">
							{t("settings:contextManagement.enableSubfolderRules.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.enableSubfolderRules.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-image-file-size"
					section="contextManagement"
					label={t("settings:contextManagement.maxImageFileSize.label")}>
					<div className="flex flex-col gap-2">
						<span className="font-medium">{t("settings:contextManagement.maxImageFileSize.label")}</span>
						<div className="flex items-center gap-4">
							<Input
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE_MB}
								min={1}
								max={100}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 100) {
										setCachedStateField("maxImageFileSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-image-file-size-input"
							/>
							<span>{t("settings:contextManagement.maxImageFileSize.mb")}</span>
						</div>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-2">
						{t("settings:contextManagement.maxImageFileSize.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-total-image-size"
					section="contextManagement"
					label={t("settings:contextManagement.maxTotalImageSize.label")}>
					<div className="flex flex-col gap-2">
						<span className="font-medium">{t("settings:contextManagement.maxTotalImageSize.label")}</span>
						<div className="flex items-center gap-4">
							<Input
								type="number"
								pattern="[0-9]*"
								className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								value={maxTotalImageSize ?? DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB}
								min={1}
								max={500}
								onChange={(e) => {
									const newValue = parseInt(e.target.value, 10)
									if (!isNaN(newValue) && newValue >= 1 && newValue <= 500) {
										setCachedStateField("maxTotalImageSize", newValue)
									}
								}}
								onClick={(e) => e.currentTarget.select()}
								data-testid="max-total-image-size-input"
							/>
							<span>{t("settings:contextManagement.maxTotalImageSize.mb")}</span>
						</div>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-2">
						{t("settings:contextManagement.maxTotalImageSize.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-diagnostic-messages"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.includeMessages.label")}>
					<VSCodeCheckbox
						checked={includeDiagnosticMessages}
						onChange={(e: any) => setCachedStateField("includeDiagnosticMessages", e.target.checked)}
						data-testid="include-diagnostic-messages-checkbox">
						<label className="block mb-1">
							{t("settings:contextManagement.diagnostics.includeMessages.label")}
						</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.diagnostics.includeMessages.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-max-diagnostic-messages"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.maxMessages.label")}>
					<span className="block mb-1">{t("settings:contextManagement.diagnostics.maxMessages.label")}</span>
					<div className="flex items-center gap-2">
						<Slider
							min={1}
							max={100}
							step={1}
							value={[toSliderValue(maxDiagnosticMessages)]}
							onValueChange={([value]) =>
								setCachedStateField("maxDiagnosticMessages", fromSliderValue(value))
							}
							data-testid="max-diagnostic-messages-slider"
							aria-label={t("settings:contextManagement.diagnostics.maxMessages.label")}
							aria-valuemin={1}
							aria-valuemax={100}
							aria-valuenow={toSliderValue(maxDiagnosticMessages)}
							aria-valuetext={
								isUnlimited(maxDiagnosticMessages)
									? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
									: `${maxDiagnosticMessages ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGES} ${t("settings:contextManagement.diagnostics.maxMessages.label")}`
							}
						/>
						<span className="w-20 text-sm font-medium">
							{isUnlimited(maxDiagnosticMessages)
								? t("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel")
								: (maxDiagnosticMessages ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGES)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCachedStateField("maxDiagnosticMessages", 50)}
							title={t("settings:contextManagement.diagnostics.maxMessages.resetTooltip")}
							className="p-1 h-6 w-6"
							disabled={maxDiagnosticMessages === 50}>
							<span className="codicon codicon-discard" />
						</Button>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.diagnostics.maxMessages.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-write-delay"
					section="contextManagement"
					label={t("settings:contextManagement.diagnostics.delayAfterWrite.label")}>
					<span className="block mb-1">
						{t("settings:contextManagement.diagnostics.delayAfterWrite.label")}
					</span>
					<div className="flex items-center gap-2">
						<Slider
							min={0}
							max={5000}
							step={100}
							value={[writeDelayMs]}
							onValueChange={([value]) => setCachedStateField("writeDelayMs", value)}
							data-testid="write-delay-slider"
						/>
						<span className="w-20">{writeDelayMs}ms</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:contextManagement.diagnostics.delayAfterWrite.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-time"
					section="contextManagement"
					label={t("settings:contextManagement.includeCurrentTime.label")}>
					<VSCodeCheckbox
						checked={includeCurrentTime}
						onChange={(e: any) => setCachedStateField("includeCurrentTime", e.target.checked)}
						data-testid="include-current-time-checkbox">
						<label className="block mb-1">{t("settings:contextManagement.includeCurrentTime.label")}</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.includeCurrentTime.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="context-include-current-cost"
					section="contextManagement"
					label={t("settings:contextManagement.includeCurrentCost.label")}>
					<VSCodeCheckbox
						checked={includeCurrentCost}
						onChange={(e: any) => setCachedStateField("includeCurrentCost", e.target.checked)}
						data-testid="include-current-cost-checkbox">
						<label className="block mb-1">{t("settings:contextManagement.includeCurrentCost.label")}</label>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
						{t("settings:contextManagement.includeCurrentCost.description")}
					</div>
				</SearchableSetting>
			</Section>
			<Section className="pt-2">
				{/* Context Condensing Prompt Editor */}
				<SearchableSetting
					settingId="context-condense-prompt"
					section="contextManagement"
					label={t("prompts:supportPrompts.types.CONDENSE.label")}>
					<div className="flex justify-between items-center mb-1">
						<label className="block">{t("prompts:supportPrompts.types.CONDENSE.label")}</label>
						<StandardTooltip content={t("prompts:supportPrompts.resetPrompt", { promptType: "CONDENSE" })}>
							<Button variant="ghost" size="icon" onClick={handleCondenseReset}>
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:supportPrompts.types.CONDENSE.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={getCondensePromptValue()}
						onInput={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateCondensePrompt(value)
						}}
						rows={6}
						className="w-full"
						data-testid="condense-prompt-textarea"
					/>
				</SearchableSetting>

				{/* Auto Condense Context */}
				<SearchableSetting
					settingId="context-auto-condense"
					section="contextManagement"
					label={t("settings:contextManagement.autoCondenseContext.name")}>
					<VSCodeCheckbox
						checked={autoCondenseContext}
						onChange={(e: any) => setCachedStateField("autoCondenseContext", e.target.checked)}
						data-testid="auto-condense-context-checkbox">
						<span className="font-medium">{t("settings:contextManagement.autoCondenseContext.name")}</span>
					</VSCodeCheckbox>
				</SearchableSetting>
				{autoCondenseContext && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div className="flex items-center gap-4 font-bold">
							<FoldVertical size={16} />
							<div>{t("settings:contextManagement.condensingThreshold.label")}</div>
						</div>
						<div>
							<Select
								// The state starts at "default" and every option carries a value.
								value={selectedThresholdProfile}
								onValueChange={(value) => {
									setSelectedThresholdProfile(value)
								}}
								data-testid="threshold-profile-select">
								<SelectTrigger className="w-full">
									<SelectValue
										placeholder={t("settings:contextManagement.condensingThreshold.selectProfile")}
									/>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">
										{t("settings:contextManagement.condensingThreshold.defaultProfile")}
									</SelectItem>
									{(listApiConfigMeta || []).map((config) => {
										const profileThreshold = profileThresholds[config.id]
										const thresholdDisplay =
											profileThreshold !== undefined
												? profileThreshold === -1
													? ` ${t(
															"settings:contextManagement.condensingThreshold.usesGlobal",
															{
																threshold: autoCondenseContextPercent,
															},
														)}`
													: ` (${profileThreshold}%)`
												: ""
										return (
											<SelectItem key={config.id} value={config.id}>
												{config.name}
												{thresholdDisplay}
											</SelectItem>
										)
									})}
								</SelectContent>
							</Select>
						</div>

						{/* Threshold Slider */}
						<div>
							<div className="flex items-center gap-2">
								<Slider
									min={10}
									max={100}
									step={1}
									value={[getCurrentThresholdValue()]}
									onValueChange={([value]) => handleThresholdChange(value)}
									data-testid="condense-threshold-slider"
								/>
								<span className="w-20">{getCurrentThresholdValue()}%</span>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{selectedThresholdProfile === "default"
									? t("settings:contextManagement.condensingThreshold.defaultDescription", {
											threshold: autoCondenseContextPercent,
										})
									: t("settings:contextManagement.condensingThreshold.profileDescription")}
							</div>
						</div>
					</div>
				)}
			</Section>
		</div>
	)
}
