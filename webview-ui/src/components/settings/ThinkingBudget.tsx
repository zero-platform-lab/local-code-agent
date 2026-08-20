/*
Semantics for Reasoning Effort (ThinkingBudget)

Capability surface:
- modelInfo.supportsReasoningEffort: boolean | Array&lt;"disable" | "none" | "minimal" | "low" | "medium" | "high"&gt;
  - true  → UI shows ["low","medium","high"]
  - array → UI shows exactly the provided values

Selection behavior:
- "disable":
  - Label: t("settings:providers.reasoningEffort.disable")（「サーバ既定（送信しない）」）
  - set enableReasoningEffort = false
  - persist reasoningEffort = "disable"
  - request builders omit any reasoning parameter/body sections
- "none":
  - Label: t("settings:providers.reasoningEffort.none")
  - set enableReasoningEffort = true
  - persist reasoningEffort = "none"
  - request builders include reasoning with value "none"
- "minimal" | "low" | "medium" | "high":
  - set enableReasoningEffort = true
  - persist the selected value
  - request builders include reasoning with the selected effort

Required:
- If modelInfo.requiredReasoningEffort is true, do not synthesize a "None" choice. Only show values from the capability.
- On mount, if unset and a default exists, set enableReasoningEffort = true and use modelInfo.reasoningEffort.

Notes:
- Current selection is normalized to the capability: unsupported persisted values are not shown.
- "disable" と "none" は別ラベルで表示する。"none" は reasoning_effort:"none" を明示送信するもので、
  GPT-5 系を chat.completions + tools で通す唯一の手段。"disable" は送信しない（サーバ既定）。
- "minimal" uses t("settings:providers.reasoningEffort.minimal").
*/

import { useEffect } from "react"
import { Checkbox } from "vscrui"

import {
	type ProviderSettings,
	type ModelInfo,
	type ReasoningEffortWithMinimal,
	reasoningEfforts,
} from "@openai-agent/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

interface ThinkingBudgetProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	modelInfo?: ModelInfo
}

export const ThinkingBudget = ({ apiConfiguration, setApiConfigurationField, modelInfo }: ThinkingBudgetProps) => {
	const { t } = useAppTranslation()

	// Check model capabilities
	const isReasoningSupported = !!modelInfo && modelInfo.supportsReasoningBinary
	const isReasoningEffortSupported = !!modelInfo && modelInfo.supportsReasoningEffort

	// Build available reasoning efforts list from capability
	const supports = modelInfo?.supportsReasoningEffort
	const baseAvailableOptions: ReadonlyArray<ReasoningEffortWithMinimal> =
		supports === true
			? (reasoningEfforts as readonly ReasoningEffortWithMinimal[])
			: Array.isArray(supports)
				? (supports as ReadonlyArray<ReasoningEffortWithMinimal>)
				: (reasoningEfforts as readonly ReasoningEffortWithMinimal[])

	// "disable" は reasoning_effort を送らない（サーバ既定に従う）。
	// "none" は reasoning_effort: "none" を明示的に送る。GPT-5 系を chat.completions +
	// tools で通す唯一の手段なので、両方を別ラベルで出す。
	// Add "disable" option only when:
	// 1. requiredReasoningEffort is not true, AND
	// 2. supportsReasoningEffort is boolean true (not an explicit array)
	// When the model provides an explicit array, respect those exact values.
	type ReasoningEffortOption = ReasoningEffortWithMinimal | "none" | "disable"
	const shouldAutoAddDisable =
		!modelInfo?.requiredReasoningEffort && supports === true && !baseAvailableOptions.includes("disable" as any)
	const availableOptions: ReadonlyArray<ReasoningEffortOption> = shouldAutoAddDisable
		? (["disable", ...baseAvailableOptions] as ReasoningEffortOption[])
		: (baseAvailableOptions as ReadonlyArray<ReasoningEffortOption>)

	// Default reasoning effort - use model's default if available
	// GPT-5 models have "medium" as their default in the model configuration
	const modelDefaultReasoningEffort = modelInfo?.reasoningEffort as ReasoningEffortWithMinimal | undefined
	const defaultReasoningEffort: ReasoningEffortOption = modelInfo?.requiredReasoningEffort
		? modelDefaultReasoningEffort || "medium"
		: "disable"
	// Current reasoning effort from settings, or fall back to default
	const storedReasoningEffort = apiConfiguration.reasoningEffort as ReasoningEffortOption | undefined
	const currentReasoningEffort: ReasoningEffortOption = storedReasoningEffort || defaultReasoningEffort

	// Set default reasoning effort when model supports it and no value is set
	useEffect(() => {
		if (isReasoningEffortSupported && !apiConfiguration.reasoningEffort) {
			// Only set a default if reasoning is required, otherwise leave as undefined (which maps to "disable")
			if (modelInfo?.requiredReasoningEffort && defaultReasoningEffort !== "disable") {
				setApiConfigurationField("reasoningEffort", defaultReasoningEffort as ReasoningEffortWithMinimal, false)
			}
		}
	}, [
		isReasoningEffortSupported,
		apiConfiguration.reasoningEffort,
		defaultReasoningEffort,
		modelInfo?.requiredReasoningEffort,
		setApiConfigurationField,
	])

	// Sync enableReasoningEffort based on selection
	// "disable" turns off reasoning; "none" is a valid level (reasoning enabled)
	useEffect(() => {
		if (!isReasoningEffortSupported) return
		const shouldEnable = modelInfo?.requiredReasoningEffort || currentReasoningEffort !== "disable"
		if (shouldEnable && apiConfiguration.enableReasoningEffort !== true) {
			setApiConfigurationField("enableReasoningEffort", true, false)
		}
	}, [
		isReasoningEffortSupported,
		modelInfo?.requiredReasoningEffort,
		currentReasoningEffort,
		apiConfiguration.enableReasoningEffort,
		setApiConfigurationField,
	])

	const enableReasoningEffort = apiConfiguration.enableReasoningEffort

	if (!modelInfo) {
		return null
	}

	// Models with supportsReasoningBinary (binary reasoning) show a simple on/off toggle
	if (isReasoningSupported) {
		return (
			<div className="flex flex-col gap-1">
				<Checkbox
					checked={enableReasoningEffort}
					onChange={(checked: boolean) =>
						setApiConfigurationField("enableReasoningEffort", checked === true)
					}>
					{t("settings:providers.useReasoning")}
				</Checkbox>
			</div>
		)
	}

	return isReasoningEffortSupported ? (
		<div className="flex flex-col gap-1" data-testid="reasoning-effort">
			<div className="flex justify-between items-center">
				<label className="block mb-1">{t("settings:providers.reasoningEffort.label")}</label>
			</div>
			<Select
				value={currentReasoningEffort}
				onValueChange={(value: ReasoningEffortOption) => {
					// "disable" turns off reasoning entirely; "none" is a valid reasoning level
					if (value === "disable") {
						setApiConfigurationField("enableReasoningEffort", false)
						setApiConfigurationField("reasoningEffort", "disable")
					} else {
						// "none", "minimal", "low", "medium", "high" all enable reasoning
						setApiConfigurationField("enableReasoningEffort", true)
						setApiConfigurationField("reasoningEffort", value as ReasoningEffortWithMinimal)
					}
				}}>
				<SelectTrigger className="w-full">
					<SelectValue
						// currentReasoningEffort always falls back to a level, so there is always a label.
						placeholder={t(`settings:providers.reasoningEffort.${currentReasoningEffort}`)}
					/>
				</SelectTrigger>
				<SelectContent>
					{availableOptions.map((value) => (
						<SelectItem key={value} value={value}>
							{t(`settings:providers.reasoningEffort.${value}`)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	) : null
}
