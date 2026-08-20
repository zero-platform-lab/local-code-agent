import React, { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useDebounce } from "react-use"

import { type ProviderName, type ProviderSettings, DEFAULT_CONSECUTIVE_MISTAKE_LIMIT } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"
import { validateApiConfigurationExcludingModelErrors, getModelValidationError } from "@src/utils/validate"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { SearchableSelect, Collapsible, CollapsibleTrigger, CollapsibleContent } from "@src/components/ui"

import { OpenAICompatible } from "./providers"

import { PROVIDERS } from "./constants"
import { inputEventTransform, noTransform } from "./transforms"
import { ApiErrorMessage } from "./ApiErrorMessage"
import { ThinkingBudget } from "./ThinkingBudget"
import { Verbosity } from "./Verbosity"
import { TodoListSettingsControl } from "./TodoListSettingsControl"
import { WebFetchSettingsControl } from "./WebFetchSettingsControl"
import { TemperatureControl } from "./TemperatureControl"
import { RateLimitSecondsControl } from "./RateLimitSecondsControl"
import { ConsecutiveMistakeLimitControl } from "./ConsecutiveMistakeLimitControl"

export interface ApiOptionsProps {
	uriScheme: string | undefined
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	errorMessage: string | undefined
	setErrorMessage: React.Dispatch<React.SetStateAction<string | undefined>>
}

const ApiOptions = ({ apiConfiguration, setApiConfigurationField, errorMessage, setErrorMessage }: ApiOptionsProps) => {
	const { t } = useAppTranslation()
	const { organizationAllowList } = useExtensionState()

	// The custom headers are owned by the provider form (OpenAICompatible); this view only
	// reads them, so that the two do not write over each other.
	const customHeaders = apiConfiguration?.openAiHeaders

	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const {
		provider: selectedProvider,
		id: selectedModelId,
		info: selectedModelInfo,
	} = useSelectedModel(apiConfiguration)

	// Update `apiModelId` whenever `selectedModelId` changes.
	useEffect(() => {
		if (selectedModelId && apiConfiguration.apiModelId !== selectedModelId) {
			// Pass false as third parameter to indicate this is not a user action
			// This is an internal sync, not a user-initiated change
			setApiConfigurationField("apiModelId", selectedModelId, false)
		}
	}, [selectedModelId, setApiConfigurationField, apiConfiguration.apiModelId])

	// Debounced refresh model updates, only executed 250ms after the user
	// stops typing.
	useDebounce(
		() => {
			if (selectedProvider === "openai") {
				vscode.postMessage({
					type: "requestOpenAiModels",
					values: {
						baseUrl: apiConfiguration?.openAiBaseUrl,
						apiKey: apiConfiguration?.openAiApiKey,
						customHeaders: {},
						openAiHeaders: customHeaders ?? {},
						// モデル一覧もそのプロファイルの経路で取りに行く。
						openAiProxyMode: apiConfiguration?.openAiProxyMode,
						openAiProxyUrl: apiConfiguration?.openAiProxyUrl,
					},
				})
			}
		},
		250,
		[
			selectedProvider,
			apiConfiguration?.openAiBaseUrl,
			apiConfiguration?.openAiApiKey,
			apiConfiguration?.openAiProxyMode,
			apiConfiguration?.openAiProxyUrl,
			customHeaders,
		],
	)

	useEffect(() => {
		const apiValidationResult = validateApiConfigurationExcludingModelErrors(
			apiConfiguration,
			organizationAllowList,
		)
		setErrorMessage(apiValidationResult)
	}, [apiConfiguration, organizationAllowList, setErrorMessage])

	const onProviderChange = useCallback(
		(value: ProviderName) => {
			// [INTERNAL] Only the OpenAI Compatible provider is selectable in this build,
			// and its model id is entered manually, so switching providers only needs to
			// record the selection.
			setApiConfigurationField("apiProvider", value)
		},
		[setApiConfigurationField],
	)

	const modelValidationError = useMemo(() => {
		return getModelValidationError(apiConfiguration, organizationAllowList)
	}, [apiConfiguration, organizationAllowList])

	const providerOptions = useMemo(() => {
		return PROVIDERS.map(({ value, label }) => ({ value, label }))
	}, [])

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1 relative">
				<div className="flex justify-between items-center">
					<label className="block">{t("settings:providers.apiProvider")}</label>
				</div>
				<SearchableSelect
					value={selectedProvider}
					onValueChange={(value) => onProviderChange(value as ProviderName)}
					options={providerOptions}
					placeholder={t("settings:common.select")}
					searchPlaceholder={t("settings:providers.searchProviderPlaceholder")}
					emptyMessage={t("settings:providers.noProviderMatchFound")}
					className="w-full"
					data-testid="provider-select"
				/>
			</div>

			{errorMessage && <ApiErrorMessage errorMessage={errorMessage} />}

			<>
				{selectedProvider === "openai" && (
					<OpenAICompatible
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						organizationAllowList={organizationAllowList}
						modelValidationError={modelValidationError}
					/>
				)}

				{
					<ThinkingBudget
						key={`${selectedProvider}-${selectedModelId}`}
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						modelInfo={selectedModelInfo}
					/>
				}

				{selectedModelInfo?.supportsVerbosity && (
					<Verbosity
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						modelInfo={selectedModelInfo}
					/>
				)}

				{
					<Collapsible open={isAdvancedSettingsOpen} onOpenChange={setIsAdvancedSettingsOpen}>
						<CollapsibleTrigger className="flex items-center gap-1 w-full cursor-pointer hover:opacity-80 mb-2">
							<span
								className={`codicon codicon-chevron-${isAdvancedSettingsOpen ? "down" : "right"}`}></span>
							<span className="font-medium">{t("settings:advancedSettings.title")}</span>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-3">
							<TodoListSettingsControl
								todoListEnabled={apiConfiguration.todoListEnabled}
								onChange={(field, value) => setApiConfigurationField(field, value)}
							/>
							<WebFetchSettingsControl
								webFetchEnabled={apiConfiguration.webFetchEnabled}
								onChange={(field, value) => setApiConfigurationField(field, value)}
							/>
							{selectedModelInfo?.supportsTemperature !== false && (
								<TemperatureControl
									value={apiConfiguration.modelTemperature}
									onChange={handleInputChange("modelTemperature", noTransform)}
									maxValue={2}
									defaultValue={selectedModelInfo?.defaultTemperature}
								/>
							)}
							<RateLimitSecondsControl
								value={apiConfiguration.rateLimitSeconds || 0}
								onChange={(value) => setApiConfigurationField("rateLimitSeconds", value)}
							/>
							<ConsecutiveMistakeLimitControl
								value={
									apiConfiguration.consecutiveMistakeLimit !== undefined
										? apiConfiguration.consecutiveMistakeLimit
										: DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
								}
								onChange={(value) => setApiConfigurationField("consecutiveMistakeLimit", value)}
							/>
						</CollapsibleContent>
					</Collapsible>
				}
			</>
		</div>
	)
}

export default memo(ApiOptions)
