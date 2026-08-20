import { useState, useCallback, useEffect } from "react"
import { useEvent } from "react-use"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type ModelInfo,
	type ReasoningEffort,
	type OrganizationAllowList,
	type ExtensionMessage,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
} from "@openai-agent/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, StandardTooltip } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

import { ProxySettingsControl } from "../ProxySettingsControl"
import { convertHeadersToObject } from "../utils/headers"
import { inputEventTransform, urlInputEventTransform, noTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { ThinkingBudget } from "../ThinkingBudget"

type OpenAICompatibleProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const OpenAICompatible = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: OpenAICompatibleProps) => {
	const { t } = useAppTranslation()

	const [azureApiVersionSelected, setAzureApiVersionSelected] = useState(!!apiConfiguration?.azureApiVersion)

	const [openAiModels, setOpenAiModels] = useState<Record<string, ModelInfo> | null>(null)

	// Connection test (verifies the endpoint is reachable / usable).
	const [isTestingConnection, setIsTestingConnection] = useState(false)
	const [connectionTestResult, setConnectionTestResult] = useState<{
		success: boolean
		message: string
		diagnostics?: { humanReadable?: string }
	} | null>(null)

	const [customHeaders, setCustomHeaders] = useState<[string, string][]>(() => {
		const headers = apiConfiguration?.openAiHeaders || {}
		return Object.entries(headers)
	})

	const handleAddCustomHeader = useCallback(() => {
		// Only update the local state to show the new row in the UI.
		setCustomHeaders((prev) => [...prev, ["", ""]])
		// Do not update the main configuration yet, wait for user input.
	}, [])

	const handleUpdateHeaderKey = useCallback((index: number, newKey: string) => {
		setCustomHeaders((prev) => {
			const updated = [...prev]

			if (updated[index]) {
				updated[index] = [newKey, updated[index][1]]
			}

			return updated
		})
	}, [])

	const handleUpdateHeaderValue = useCallback((index: number, newValue: string) => {
		setCustomHeaders((prev) => {
			const updated = [...prev]

			if (updated[index]) {
				updated[index] = [updated[index][0], newValue]
			}

			return updated
		})
	}, [])

	const handleRemoveCustomHeader = useCallback((index: number) => {
		setCustomHeaders((prev) => prev.filter((_, i) => i !== index))
	}, [])

	// Helper to convert array of tuples to object

	// Add effect to update the parent component's state when local headers change
	useEffect(() => {
		const timer = setTimeout(() => {
			const headerObject = convertHeadersToObject(customHeaders)
			setApiConfigurationField("openAiHeaders", headerObject, false)
		}, 300)

		return () => clearTimeout(timer)
	}, [customHeaders, setApiConfigurationField])

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

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "openAiModels": {
				const updatedModels = message.openAiModels ?? []
				setOpenAiModels(Object.fromEntries(updatedModels.map((item) => [item, openAiModelInfoSaneDefaults])))
				break
			}
			case "apiConnectionTest": {
				setIsTestingConnection(false)
				setConnectionTestResult({
					success: message.success ?? false,
					message: message.text ?? "",
					diagnostics: (message.values as { diagnostics?: { humanReadable?: string } } | undefined)
						?.diagnostics,
				})
				break
			}
		}
	}, [])

	useEvent("message", onMessage)

	const handleTestConnection = useCallback(() => {
		setConnectionTestResult(null)
		setIsTestingConnection(true)
		vscode.postMessage({
			type: "testApiConnection",
			values: {
				baseUrl: apiConfiguration?.openAiBaseUrl,
				apiKey: apiConfiguration?.openAiApiKey,
				openAiHeaders: convertHeadersToObject(customHeaders),
				modelId: apiConfiguration?.openAiModelId,
				useAzure: apiConfiguration?.openAiUseAzure,
				azureApiVersion: apiConfiguration?.azureApiVersion,
			},
		})
	}, [
		apiConfiguration?.openAiBaseUrl,
		apiConfiguration?.openAiApiKey,
		apiConfiguration?.openAiModelId,
		apiConfiguration?.openAiUseAzure,
		apiConfiguration?.azureApiVersion,
		customHeaders,
	])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.openAiBaseUrl || ""}
				type="url"
				onInput={handleInputChange("openAiBaseUrl", urlInputEventTransform)}
				placeholder={t("settings:placeholders.baseUrl")}
				className="w-full">
				<label className="block mb-1">{t("settings:providers.openAiBaseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.openAiApiKey || ""}
				type="password"
				onInput={handleInputChange("openAiApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block mb-1">{t("settings:providers.apiKey")}</label>
			</VSCodeTextField>
			<div className="flex flex-col gap-1">
				<Button
					variant="secondary"
					onClick={handleTestConnection}
					disabled={
						isTestingConnection || !apiConfiguration?.openAiBaseUrl || !apiConfiguration?.openAiModelId
					}
					data-testid="test-connection-button">
					{isTestingConnection
						? t("settings:providers.testingConnection")
						: t("settings:providers.testConnection")}
				</Button>
				{connectionTestResult && (
					<>
						<p
							className={`text-sm mt-1 mb-0 ${
								connectionTestResult.success
									? "text-vscode-charts-green"
									: "text-vscode-errorForeground"
							}`}
							data-testid="test-connection-result">
							{connectionTestResult.success ? "✓ " : "✕ "}
							{connectionTestResult.message}
						</p>
						{connectionTestResult.diagnostics?.humanReadable && (
							<details className="mt-1" data-testid="test-connection-diagnostics">
								<summary className="text-xs text-vscode-descriptionForeground cursor-pointer">
									{t("settings:providers.testConnectionDiagnostics", {
										defaultValue: "詳細（送受信の内容）",
									})}
								</summary>
								<pre className="text-xs mt-1 p-2 bg-vscode-textCodeBlock-background overflow-auto whitespace-pre-wrap">
									{connectionTestResult.diagnostics.humanReadable}
								</pre>
							</details>
						)}
					</>
				)}
			</div>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId="gpt-4o"
				models={openAiModels}
				modelIdKey="openAiModelId"
				serviceName="OpenAI"
				serviceUrl="https://platform.openai.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
			<Checkbox
				checked={apiConfiguration?.openAiStreamingEnabled ?? true}
				onChange={handleInputChange("openAiStreamingEnabled", noTransform)}>
				{t("settings:modelInfo.enableStreaming")}
			</Checkbox>
			<div>
				<Checkbox
					checked={apiConfiguration?.includeMaxTokens === true}
					onChange={handleInputChange("includeMaxTokens", noTransform)}>
					{t("settings:includeMaxOutputTokens")}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6">
					{t("settings:includeMaxOutputTokensDescription")}
				</div>
			</div>
			<Checkbox
				checked={apiConfiguration?.openAiUseAzure ?? false}
				onChange={handleInputChange("openAiUseAzure", noTransform)}>
				{t("settings:modelInfo.useAzure")}
			</Checkbox>
			<div>
				<Checkbox
					checked={apiConfiguration?.openAiUseResponsesApi ?? false}
					onChange={handleInputChange("openAiUseResponsesApi", noTransform)}>
					{t("settings:modelInfo.useResponsesApi", {
						defaultValue: "Responses API を使用（GPT-5 系で reasoning + tool 併用）",
					})}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6">
					{t("settings:modelInfo.useResponsesApiDescription", {
						defaultValue:
							"Azure OpenAI / OpenAI 本家の GPT-5 系向け。/v1/chat/completions は tool calling と reasoning の併用を拒否するため、/v1/responses に切り替える。Ollama など他の互換実装では有効にしないこと。",
					})}
				</div>
			</div>
			<div>
				<Checkbox
					checked={apiConfiguration?.openAiReasoningWithTools ?? false}
					onChange={handleInputChange("openAiReasoningWithTools", noTransform)}>
					{t("settings:modelInfo.reasoningWithTools", {
						defaultValue: "ツール併用時も reasoning を送る（実験的・chat/completions）",
					})}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6">
					{t("settings:modelInfo.reasoningWithToolsDescription", {
						defaultValue:
							"既定ではツールがあるターンは reasoning を切る（GPT-5 系の 400/ハング回避）。ON にすると chat/completions でも reasoning を効かせたまま tool を送る。/responses が使えない環境で自律性を上げたい場合の実験用。endpoint が非対応なら 400 になるので、その場合は OFF に戻す。",
					})}
				</div>
			</div>
			<ProxySettingsControl />
			<div>
				<Checkbox
					checked={azureApiVersionSelected}
					onChange={(checked: boolean) => {
						setAzureApiVersionSelected(checked)

						if (!checked) {
							setApiConfigurationField("azureApiVersion", "")
						}
					}}>
					{t("settings:modelInfo.azureApiVersion")}
				</Checkbox>
				{azureApiVersionSelected && (
					<VSCodeTextField
						value={apiConfiguration?.azureApiVersion || ""}
						onInput={handleInputChange("azureApiVersion")}
						placeholder={`Default: ${azureOpenAiDefaultApiVersion}`}
						className="w-full mt-1"
					/>
				)}
			</div>

			{/* Custom Headers UI */}
			<div className="mb-4">
				<div className="flex justify-between items-center mb-2">
					<label className="block">{t("settings:providers.customHeaders")}</label>
					<StandardTooltip content={t("settings:common.add")}>
						<VSCodeButton appearance="icon" onClick={handleAddCustomHeader}>
							<span className="codicon codicon-add"></span>
						</VSCodeButton>
					</StandardTooltip>
				</div>
				{!customHeaders.length ? (
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.noCustomHeaders")}
					</div>
				) : (
					customHeaders.map(([key, value], index) => (
						<div key={index} className="flex items-center mb-2">
							<VSCodeTextField
								value={key}
								className="flex-1 mr-2"
								placeholder={t("settings:providers.headerName")}
								onInput={(e: any) => handleUpdateHeaderKey(index, e.target.value)}
							/>
							<VSCodeTextField
								value={value}
								className="flex-1 mr-2"
								placeholder={t("settings:providers.headerValue")}
								onInput={(e: any) => handleUpdateHeaderValue(index, e.target.value)}
							/>
							<StandardTooltip content={t("settings:common.remove")}>
								<VSCodeButton appearance="icon" onClick={() => handleRemoveCustomHeader(index)}>
									<span className="codicon codicon-trash"></span>
								</VSCodeButton>
							</StandardTooltip>
						</div>
					))
				)}
			</div>

			<div className="flex flex-col gap-1">
				<Checkbox
					checked={apiConfiguration.enableReasoningEffort ?? false}
					onChange={(checked: boolean) => {
						setApiConfigurationField("enableReasoningEffort", checked)

						if (!checked) {
							const { reasoningEffort: _, ...openAiCustomModelInfo } =
								apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults

							setApiConfigurationField("openAiCustomModelInfo", openAiCustomModelInfo)
						}
					}}>
					{t("settings:providers.setReasoningLevel")}
				</Checkbox>
				{!!apiConfiguration.enableReasoningEffort && (
					<ThinkingBudget
						apiConfiguration={{
							...apiConfiguration,
							reasoningEffort: apiConfiguration.openAiCustomModelInfo?.reasoningEffort,
						}}
						setApiConfigurationField={(field, value) => {
							if (field === "reasoningEffort") {
								const openAiCustomModelInfo =
									apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults

								setApiConfigurationField("openAiCustomModelInfo", {
									...openAiCustomModelInfo,
									reasoningEffort: value as ReasoningEffort,
								})
							}
						}}
						modelInfo={{
							...(apiConfiguration.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
							// GPT-5.6 系は tool calling と reasoning を併用できず、reasoning_effort を
							// "none" にした場合のみ tool calling が通る。UI から None を選べないと
							// Azure 経由の GPT-5.6 でエージェントが機能しないため選択肢に含める。
							supportsReasoningEffort: ["none", "minimal", "low", "medium", "high", "xhigh"],
						}}
					/>
				)}
			</div>
			<div className="flex flex-col gap-3">
				<div className="text-sm text-vscode-descriptionForeground whitespace-pre-line">
					{t("settings:providers.customModel.capabilities")}
				</div>

				<div>
					<VSCodeTextField
						value={
							apiConfiguration?.openAiCustomModelInfo?.maxTokens?.toString() ||
							openAiModelInfoSaneDefaults.maxTokens?.toString()
						}
						type="text"
						style={{
							borderColor: (() => {
								const value = apiConfiguration?.openAiCustomModelInfo?.maxTokens

								if (!value) {
									return "var(--vscode-input-border)"
								}

								return value > 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
							})(),
						}}
						onInput={handleInputChange("openAiCustomModelInfo", (e) => {
							const value = parseInt((e.target as HTMLInputElement).value)

							return {
								...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
								maxTokens: isNaN(value) ? undefined : value,
							}
						})}
						placeholder={t("settings:placeholders.numbers.maxTokens")}
						className="w-full">
						<label className="block mb-1">{t("settings:providers.customModel.maxTokens.label")}</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.customModel.maxTokens.description")}
					</div>
				</div>

				<div>
					<VSCodeTextField
						value={
							apiConfiguration?.openAiCustomModelInfo?.contextWindow?.toString() ||
							openAiModelInfoSaneDefaults.contextWindow?.toString()
						}
						type="text"
						style={{
							borderColor: (() => {
								const value = apiConfiguration?.openAiCustomModelInfo?.contextWindow

								if (!value) {
									return "var(--vscode-input-border)"
								}

								return value > 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
							})(),
						}}
						onInput={handleInputChange("openAiCustomModelInfo", (e) => {
							const value = (e.target as HTMLInputElement).value
							const parsed = parseInt(value)

							return {
								...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
								contextWindow: isNaN(parsed) ? openAiModelInfoSaneDefaults.contextWindow : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.contextWindow")}
						className="w-full">
						<label className="block mb-1">{t("settings:providers.customModel.contextWindow.label")}</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.customModel.contextWindow.description")}
					</div>
				</div>

				<div>
					<div className="flex items-center gap-1">
						<Checkbox
							checked={
								apiConfiguration?.openAiCustomModelInfo?.supportsImages ??
								openAiModelInfoSaneDefaults.supportsImages
							}
							onChange={handleInputChange("openAiCustomModelInfo", (checked) => {
								return {
									...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
									supportsImages: checked,
								}
							})}>
							<span className="font-medium">
								{t("settings:providers.customModel.imageSupport.label")}
							</span>
						</Checkbox>
						<StandardTooltip content={t("settings:providers.customModel.imageSupport.description")}>
							<i
								className="codicon codicon-info text-vscode-descriptionForeground"
								style={{ fontSize: "12px" }}
							/>
						</StandardTooltip>
					</div>
					<div className="text-sm text-vscode-descriptionForeground pt-1">
						{t("settings:providers.customModel.imageSupport.description")}
					</div>
				</div>

				<div>
					<VSCodeTextField
						value={
							apiConfiguration?.openAiCustomModelInfo?.inputPrice?.toString() ??
							openAiModelInfoSaneDefaults.inputPrice?.toString()
						}
						type="text"
						style={{
							borderColor: (() => {
								const value = apiConfiguration?.openAiCustomModelInfo?.inputPrice

								if (!value && value !== 0) {
									return "var(--vscode-input-border)"
								}

								return value >= 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
							})(),
						}}
						onChange={handleInputChange("openAiCustomModelInfo", (e) => {
							const value = (e.target as HTMLInputElement).value
							const parsed = parseFloat(value)

							return {
								...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
								inputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.inputPrice : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.inputPrice")}
						className="w-full">
						<div className="flex items-center gap-1">
							<label className="block mb-1">
								{t("settings:providers.customModel.pricing.input.label")}
							</label>
							<StandardTooltip content={t("settings:providers.customModel.pricing.input.description")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</VSCodeTextField>
				</div>

				<div>
					<VSCodeTextField
						value={
							apiConfiguration?.openAiCustomModelInfo?.outputPrice?.toString() ||
							openAiModelInfoSaneDefaults.outputPrice?.toString()
						}
						type="text"
						style={{
							borderColor: (() => {
								const value = apiConfiguration?.openAiCustomModelInfo?.outputPrice

								if (!value && value !== 0) {
									return "var(--vscode-input-border)"
								}

								return value >= 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
							})(),
						}}
						onChange={handleInputChange("openAiCustomModelInfo", (e) => {
							const value = (e.target as HTMLInputElement).value
							const parsed = parseFloat(value)

							return {
								...(apiConfiguration?.openAiCustomModelInfo || openAiModelInfoSaneDefaults),
								outputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.outputPrice : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.outputPrice")}
						className="w-full">
						<div className="flex items-center gap-1">
							<label className="block mb-1">
								{t("settings:providers.customModel.pricing.output.label")}
							</label>
							<StandardTooltip content={t("settings:providers.customModel.pricing.output.description")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</VSCodeTextField>
				</div>

				<div>
					<VSCodeTextField
						value={apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice?.toString() ?? "0"}
						type="text"
						style={{
							borderColor: (() => {
								const value = apiConfiguration?.openAiCustomModelInfo?.cacheReadsPrice

								if (!value && value !== 0) {
									return "var(--vscode-input-border)"
								}

								return value >= 0 ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)"
							})(),
						}}
						onChange={handleInputChange("openAiCustomModelInfo", (e) => {
							const value = (e.target as HTMLInputElement).value
							const parsed = parseFloat(value)

							return {
								...(apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
								cacheReadsPrice: isNaN(parsed) ? 0 : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.cacheReadsPrice")}
						className="w-full">
						<div className="flex items-center gap-1">
							<span className="font-medium">
								{t("settings:providers.customModel.pricing.cacheReads.label")}
							</span>
							<StandardTooltip
								content={t("settings:providers.customModel.pricing.cacheReads.description")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</VSCodeTextField>
				</div>

				<Button
					variant="secondary"
					onClick={() => setApiConfigurationField("openAiCustomModelInfo", openAiModelInfoSaneDefaults)}>
					{t("settings:providers.customModel.resetDefaults")}
				</Button>
			</div>
		</>
	)
}
