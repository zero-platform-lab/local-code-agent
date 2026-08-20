// npx vitest run src/components/settings/providers/__tests__/OpenAICompatible.wiring.spec.tsx

import { render, screen, fireEvent, act, within } from "@/utils/test-utils"

import { type ProviderSettings, azureOpenAiDefaultApiVersion, openAiModelInfoSaneDefaults } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"

import { OpenAICompatible } from "../OpenAICompatible"

vi.mock("../../ProxySettingsControl", () => ({ ProxySettingsControl: () => null }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			{children}
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
		</label>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, onChange, placeholder, style, type }: any) => (
		<div data-testid={`field-${placeholder}`} data-border-color={style?.borderColor}>
			{children}
			<input
				type={type === "password" ? "password" : "text"}
				value={value}
				placeholder={placeholder}
				onChange={(event) => {
					onInput?.(event)
					onChange?.(event)
				}}
			/>
		</div>
	),
	VSCodeButton: ({ children, onClick, appearance }: any) => (
		<button onClick={onClick} data-testid={`icon-button-${appearance}`}>
			{children}
		</button>
	),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled, "data-testid": testId }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={testId}>
			{children}
		</button>
	),
	StandardTooltip: ({ children }: any) => <>{children}</>,
	// ModelProxySettingsControl が使う。ネイティブ select に落として素直に操作できる形にする。
	Select: ({ children, value, onValueChange }: any) => (
		<select value={value} onChange={(e: any) => onValueChange?.(e.target.value)} data-testid="select-root">
			{children}
		</select>
	),
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ models, errorMessage, simplifySettings }: any) => (
		<div
			data-testid="model-picker"
			data-models={models ? Object.keys(models).join(",") : "null"}
			data-error={errorMessage ?? ""}
			data-simplified={String(simplifySettings)}
		/>
	),
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: ({ apiConfiguration, setApiConfigurationField, modelInfo }: any) => (
		<div
			data-testid="thinking-budget"
			data-effort={apiConfiguration.reasoningEffort ?? "none"}
			data-supported={modelInfo.supportsReasoningEffort.join(",")}>
			<button
				data-testid="thinking-set-effort"
				onClick={() => setApiConfigurationField("reasoningEffort", "high")}
			/>
			<button data-testid="thinking-set-other" onClick={() => setApiConfigurationField("modelMaxTokens", 4096)} />
		</div>
	),
}))

const organizationAllowList = { allowAll: true, providers: {} }

const renderProvider = (apiConfiguration: Partial<ProviderSettings> = {}, props: Record<string, unknown> = {}) => {
	const setApiConfigurationField = vi.fn()
	const utils = render(
		<OpenAICompatible
			apiConfiguration={apiConfiguration as ProviderSettings}
			setApiConfigurationField={setApiConfigurationField}
			organizationAllowList={organizationAllowList}
			{...props}
		/>,
	)
	return { setApiConfigurationField, ...utils }
}

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

const checkbox = (label: string) =>
	within(screen.getByText(label).closest("label")!).getByRole("checkbox") as HTMLInputElement

const field = (placeholder: string) => within(screen.getByTestId(`field-${placeholder}`)).getByRole("textbox")

const borderColor = (placeholder: string, index = 0) =>
	screen.getAllByTestId(`field-${placeholder}`)[index].getAttribute("data-border-color")

describe("OpenAICompatible wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("connection test", () => {
		it("is disabled until a base url is configured", () => {
			renderProvider()

			expect(screen.getByTestId("test-connection-button")).toBeDisabled()
		})

		it("is disabled until a model is configured (実補完で疎通確認するため)", () => {
			renderProvider({ openAiBaseUrl: "https://example.test/v1" })

			expect(screen.getByTestId("test-connection-button")).toBeDisabled()
		})

		it("sends the endpoint, key and headers, then reports success", () => {
			renderProvider({
				openAiBaseUrl: "https://example.test/v1",
				openAiApiKey: "secret",
				openAiHeaders: { "X-Trace": "1" },
				openAiModelId: "gpt-4o-mini",
			})

			fireEvent.click(screen.getByTestId("test-connection-button"))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "testApiConnection",
				values: {
					baseUrl: "https://example.test/v1",
					apiKey: "secret",
					openAiHeaders: { "X-Trace": "1" },
					modelId: "gpt-4o-mini",
					useAzure: undefined,
					azureApiVersion: undefined,
				},
			})
			expect(screen.getByTestId("test-connection-button")).toBeDisabled()
			expect(screen.getByText("settings:providers.testingConnection")).toBeInTheDocument()

			post({ type: "apiConnectionTest", success: true, text: "ok" })

			const result = screen.getByTestId("test-connection-result")
			expect(result).toHaveTextContent("✓ ok")
			expect(result.className).toContain("text-vscode-charts-green")
			expect(screen.getByTestId("test-connection-button")).toBeEnabled()
			expect(screen.queryByTestId("test-connection-diagnostics")).not.toBeInTheDocument()
		})

		it("reports a failure with its diagnostics", () => {
			renderProvider({ openAiBaseUrl: "https://example.test/v1", openAiModelId: "gpt-4o-mini" })

			fireEvent.click(screen.getByTestId("test-connection-button"))
			post({
				type: "apiConnectionTest",
				success: false,
				text: "boom",
				values: { diagnostics: { humanReadable: "request/response dump" } },
			})

			const result = screen.getByTestId("test-connection-result")
			expect(result).toHaveTextContent("✕ boom")
			expect(result.className).toContain("text-vscode-errorForeground")
			expect(screen.getByTestId("test-connection-diagnostics")).toHaveTextContent("request/response dump")
		})

		it("treats a result without fields as a failure", () => {
			renderProvider({ openAiBaseUrl: "https://example.test/v1", openAiModelId: "gpt-4o-mini" })

			fireEvent.click(screen.getByTestId("test-connection-button"))
			post({ type: "apiConnectionTest" })

			expect(screen.getByTestId("test-connection-result")).toHaveTextContent("✕")
			expect(screen.queryByTestId("test-connection-diagnostics")).not.toBeInTheDocument()
		})

		it("clears the previous result when a new test starts", () => {
			renderProvider({ openAiBaseUrl: "https://example.test/v1", openAiModelId: "gpt-4o-mini" })

			fireEvent.click(screen.getByTestId("test-connection-button"))
			post({ type: "apiConnectionTest", success: true, text: "ok" })
			expect(screen.getByTestId("test-connection-result")).toBeInTheDocument()

			fireEvent.click(screen.getByTestId("test-connection-button"))

			expect(screen.queryByTestId("test-connection-result")).not.toBeInTheDocument()
		})
	})

	describe("model list", () => {
		it("starts empty and fills in from the extension", () => {
			renderProvider()

			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-models", "null")

			post({ type: "openAiModels", openAiModels: ["gpt-4o", "gpt-5"] })

			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-models", "gpt-4o,gpt-5")
		})

		it("accepts an empty model list", () => {
			renderProvider()

			post({ type: "openAiModels" })

			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-models", "")
		})

		it("ignores unrelated messages", () => {
			renderProvider()

			post({ type: "state", state: {} })

			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-models", "null")
			expect(screen.queryByTestId("test-connection-result")).not.toBeInTheDocument()
		})

		it("forwards the validation error and the simplified flag", () => {
			renderProvider({}, { modelValidationError: "bad model", simplifySettings: true })

			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-error", "bad model")
			expect(screen.getByTestId("model-picker")).toHaveAttribute("data-simplified", "true")
		})
	})

	describe("endpoint fields", () => {
		it("writes the base url and the api key", () => {
			const { setApiConfigurationField } = renderProvider({ openAiBaseUrl: "https://a.test" })

			fireEvent.change(field("settings:placeholders.baseUrl"), {
				target: { value: "https://b.test/v1  " },
			})
			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiBaseUrl", "https://b.test/v1")

			fireEvent.change(screen.getByPlaceholderText("settings:placeholders.apiKey"), {
				target: { value: "sk-1" },
			})
			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiApiKey", "sk-1")
		})
	})

	describe("toggles", () => {
		it.each([
			["settings:modelInfo.enableStreaming", "openAiStreamingEnabled", true],
			// includeMaxTokens は backend が === true のときだけ送るため、未設定は unchecked が正。
			["settings:includeMaxOutputTokens", "includeMaxTokens", false],
			["settings:modelInfo.useAzure", "openAiUseAzure", false],
			["settings:modelInfo.useResponsesApi", "openAiUseResponsesApi", false],
			["settings:modelInfo.reasoningWithTools", "openAiReasoningWithTools", false],
		])("%s defaults to %s and reports the new value", (label, fieldName, defaultChecked) => {
			const { setApiConfigurationField } = renderProvider()

			expect(checkbox(label as string).checked).toBe(defaultChecked)

			fireEvent.click(checkbox(label as string))

			expect(setApiConfigurationField).toHaveBeenCalledWith(fieldName, !defaultChecked)
		})
	})

	describe("azure api version", () => {
		it("starts checked when a version is stored", () => {
			renderProvider({ azureApiVersion: "2024-01-01" })

			expect(checkbox("settings:modelInfo.azureApiVersion").checked).toBe(true)
			expect(field(`Default: ${azureOpenAiDefaultApiVersion}`)).toHaveValue("2024-01-01")
		})

		it("reveals the input when enabled and clears the version when disabled", () => {
			const { setApiConfigurationField } = renderProvider()

			expect(screen.queryByTestId(`field-Default: ${azureOpenAiDefaultApiVersion}`)).not.toBeInTheDocument()

			fireEvent.click(checkbox("settings:modelInfo.azureApiVersion"))
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("azureApiVersion", "")

			fireEvent.change(field(`Default: ${azureOpenAiDefaultApiVersion}`), { target: { value: "2025-01-01" } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("azureApiVersion", "2025-01-01")

			fireEvent.click(checkbox("settings:modelInfo.azureApiVersion"))
			expect(setApiConfigurationField).toHaveBeenCalledWith("azureApiVersion", "")
			expect(screen.queryByTestId(`field-Default: ${azureOpenAiDefaultApiVersion}`)).not.toBeInTheDocument()
		})
	})

	describe("custom headers", () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		const flush = () => act(() => vi.advanceTimersByTime(300))

		it("starts from the stored headers", () => {
			renderProvider({ openAiHeaders: { Authorization: "Bearer x" } })

			expect(screen.getByTestId("field-settings:providers.headerName")).toBeInTheDocument()
			expect(screen.queryByText("settings:providers.noCustomHeaders")).not.toBeInTheDocument()
		})

		it("adds, edits and removes rows, syncing the configuration", () => {
			const { setApiConfigurationField } = renderProvider()

			expect(screen.getByText("settings:providers.noCustomHeaders")).toBeInTheDocument()
			flush()
			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiHeaders", {}, false)
			setApiConfigurationField.mockClear()

			fireEvent.click(screen.getByTestId("icon-button-icon"))
			fireEvent.change(field("settings:providers.headerName"), { target: { value: "X-Key" } })
			fireEvent.change(field("settings:providers.headerValue"), { target: { value: "1" } })
			flush()

			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiHeaders", { "X-Key": "1" }, false)

			const removeButtons = screen.getAllByTestId("icon-button-icon")
			fireEvent.click(removeButtons[removeButtons.length - 1])
			flush()

			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiHeaders", {}, false)
			expect(screen.getByText("settings:providers.noCustomHeaders")).toBeInTheDocument()
		})

		it("keeps the value when only the header name is edited", () => {
			const { setApiConfigurationField } = renderProvider({ openAiHeaders: { A: "1" } })

			fireEvent.change(field("settings:providers.headerName"), { target: { value: "B" } })
			flush()

			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiHeaders", { B: "1" }, false)
		})

		it("keeps the rows apart when several headers are configured", () => {
			const { setApiConfigurationField } = renderProvider({ openAiHeaders: { A: "1", B: "2" } })

			fireEvent.change(screen.getAllByPlaceholderText("settings:providers.headerValue")[1], {
				target: { value: "22" },
			})
			flush()

			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiHeaders", { A: "1", B: "22" }, false)
		})
	})

	describe("reasoning effort", () => {
		it("hides the budget until it is enabled", () => {
			renderProvider()

			expect(screen.queryByTestId("thinking-budget")).not.toBeInTheDocument()
		})

		it("strips the stored effort when it is disabled", () => {
			const { setApiConfigurationField } = renderProvider({
				enableReasoningEffort: true,
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "high" },
			})

			expect(screen.getByTestId("thinking-budget")).toHaveAttribute("data-effort", "high")

			fireEvent.click(checkbox("settings:providers.setReasoningLevel"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
			expect(setApiConfigurationField).toHaveBeenCalledWith(
				"openAiCustomModelInfo",
				expect.not.objectContaining({ reasoningEffort: expect.anything() }),
			)
		})

		it("falls back to the sane defaults when nothing is stored", () => {
			const { setApiConfigurationField } = renderProvider({ enableReasoningEffort: true })

			expect(screen.getByTestId("thinking-budget")).toHaveAttribute("data-effort", "none")

			fireEvent.click(checkbox("settings:providers.setReasoningLevel"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", openAiModelInfoSaneDefaults)
		})

		it("enables it from the unchecked state", () => {
			const { setApiConfigurationField } = renderProvider()

			fireEvent.click(checkbox("settings:providers.setReasoningLevel"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
			expect(setApiConfigurationField).toHaveBeenCalledTimes(1)
		})

		it("stores the chosen effort inside the custom model info", () => {
			const { setApiConfigurationField } = renderProvider({
				enableReasoningEffort: true,
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 1234 },
			})

			fireEvent.click(screen.getByTestId("thinking-set-effort"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				maxTokens: 1234,
				reasoningEffort: "high",
			})
		})

		it("offers none as a selectable effort", () => {
			renderProvider({ enableReasoningEffort: true })

			expect(screen.getByTestId("thinking-budget")).toHaveAttribute(
				"data-supported",
				"none,minimal,low,medium,high,xhigh",
			)
		})

		it("ignores writes to other fields coming from the budget control", () => {
			const { setApiConfigurationField } = renderProvider({ enableReasoningEffort: true })

			fireEvent.click(screen.getByTestId("thinking-set-other"))

			expect(setApiConfigurationField).not.toHaveBeenCalled()
		})

		it("falls back to the sane defaults when storing an effort without stored info", () => {
			const { setApiConfigurationField } = renderProvider({ enableReasoningEffort: true })

			fireEvent.click(screen.getByTestId("thinking-set-effort"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				reasoningEffort: "high",
			})
		})
	})

	describe("custom model capabilities", () => {
		it("shows the sane defaults when nothing is stored", () => {
			renderProvider()

			expect(field("settings:placeholders.numbers.maxTokens")).toHaveValue(
				String(openAiModelInfoSaneDefaults.maxTokens),
			)
			expect(borderColor("settings:placeholders.numbers.maxTokens")).toBe("var(--vscode-input-border)")
			expect(borderColor("settings:placeholders.numbers.contextWindow")).toBe("var(--vscode-input-border)")
		})

		it("colours the max tokens by sign", () => {
			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 10 } })
			expect(borderColor("settings:placeholders.numbers.maxTokens")).toBe("var(--vscode-charts-green)")

			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: -1 } })
			expect(borderColor("settings:placeholders.numbers.maxTokens", 1)).toBe("var(--vscode-errorForeground)")
		})

		it("colours the context window by sign", () => {
			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, contextWindow: 10 } })
			expect(borderColor("settings:placeholders.numbers.contextWindow")).toBe("var(--vscode-charts-green)")

			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, contextWindow: -1 } })
			expect(borderColor("settings:placeholders.numbers.contextWindow", 1)).toBe("var(--vscode-errorForeground)")
		})

		it("writes the max tokens and clears them when the input is not a number", () => {
			const { setApiConfigurationField } = renderProvider()

			fireEvent.change(field("settings:placeholders.numbers.maxTokens"), { target: { value: "4096" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				maxTokens: 4096,
			})

			fireEvent.change(field("settings:placeholders.numbers.maxTokens"), { target: { value: "" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				maxTokens: undefined,
			})
		})

		it("writes the context window and falls back to the default when it is not a number", () => {
			const { setApiConfigurationField } = renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, contextWindow: 1000 },
			})

			fireEvent.change(field("settings:placeholders.numbers.contextWindow"), { target: { value: "2000" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				contextWindow: 2000,
			})

			fireEvent.change(field("settings:placeholders.numbers.contextWindow"), { target: { value: "abc" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				contextWindow: openAiModelInfoSaneDefaults.contextWindow,
			})
		})

		it("toggles image support", () => {
			const { setApiConfigurationField } = renderProvider()

			fireEvent.click(checkbox("settings:providers.customModel.imageSupport.label"))

			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				supportsImages: !openAiModelInfoSaneDefaults.supportsImages,
			})
		})

		it("keeps the stored image support flag", () => {
			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsImages: false } })

			expect(checkbox("settings:providers.customModel.imageSupport.label").checked).toBe(false)
		})

		it("shows the cache read price field without a prompt-cache toggle", () => {
			// supportsPromptCache は backend が見ない no-op だったため UI トグルを撤去。
			// cacheReadsPrice は cost 計算が無条件に使う（cacheReadTokens>0 時）ので常時表示。
			renderProvider()

			expect(screen.queryByText("settings:providers.customModel.promptCache.label")).toBeNull()
			// cacheReadsPrice は専用 testid で常に描画される（トグル無し）
			expect(screen.getByTestId("field-settings:placeholders.numbers.inputPrice")).toBeInTheDocument()
			expect(screen.getByTestId("field-settings:placeholders.numbers.cacheReadsPrice")).toBeInTheDocument()
		})

		it("edits cache read price even without existing custom model info (falls back to defaults)", () => {
			const { setApiConfigurationField } = renderProvider() // openAiCustomModelInfo 未設定

			fireEvent.change(field("settings:placeholders.numbers.cacheReadsPrice"), { target: { value: "0.3" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				cacheReadsPrice: 0.3,
			})
		})

		it("edits the cache read price", () => {
			const { setApiConfigurationField } = renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsPromptCache: true },
			})

			const cacheField = screen.getByTestId("field-settings:placeholders.numbers.cacheReadsPrice")
			expect(cacheField.getAttribute("data-border-color")).toBe("var(--vscode-input-border)")

			fireEvent.change(within(cacheField).getByRole("textbox"), { target: { value: "0.5" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				supportsPromptCache: true,
				cacheReadsPrice: 0.5,
			})

			fireEvent.change(within(cacheField).getByRole("textbox"), { target: { value: "" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				supportsPromptCache: true,
				cacheReadsPrice: 0,
			})
		})

		it("colours the cache read price by sign", () => {
			renderProvider({
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsPromptCache: true,
					cacheReadsPrice: 1,
				},
			})
			expect(borderColor("settings:placeholders.numbers.cacheReadsPrice", 0)).toBe("var(--vscode-charts-green)")

			renderProvider({
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsPromptCache: true,
					cacheReadsPrice: -1,
				},
			})
			expect(borderColor("settings:placeholders.numbers.cacheReadsPrice", 1)).toBe(
				"var(--vscode-errorForeground)",
			)
		})

		it("writes the input price and falls back to the default when it is not a number", () => {
			const { setApiConfigurationField } = renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, inputPrice: 1 },
			})

			fireEvent.change(field("settings:placeholders.numbers.inputPrice"), { target: { value: "2.5" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				inputPrice: 2.5,
			})

			fireEvent.change(field("settings:placeholders.numbers.inputPrice"), { target: { value: "x" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				inputPrice: openAiModelInfoSaneDefaults.inputPrice,
			})
		})

		it("colours the prices by sign", () => {
			renderProvider({ openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, inputPrice: 0, outputPrice: 0 } })
			expect(borderColor("settings:placeholders.numbers.inputPrice")).toBe("var(--vscode-charts-green)")
			expect(borderColor("settings:placeholders.numbers.outputPrice")).toBe("var(--vscode-charts-green)")

			renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, inputPrice: -1, outputPrice: -1 },
			})
			expect(borderColor("settings:placeholders.numbers.inputPrice", 1)).toBe("var(--vscode-errorForeground)")
			expect(borderColor("settings:placeholders.numbers.outputPrice", 1)).toBe("var(--vscode-errorForeground)")

			renderProvider({
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
					inputPrice: undefined,
					outputPrice: undefined,
				},
			})
			expect(borderColor("settings:placeholders.numbers.inputPrice", 2)).toBe("var(--vscode-input-border)")
			expect(borderColor("settings:placeholders.numbers.outputPrice", 2)).toBe("var(--vscode-input-border)")
		})

		it("writes the output price and falls back to the default when it is not a number", () => {
			const { setApiConfigurationField } = renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, outputPrice: 1 },
			})

			fireEvent.change(field("settings:placeholders.numbers.outputPrice"), { target: { value: "3.5" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				outputPrice: 3.5,
			})

			fireEvent.change(field("settings:placeholders.numbers.outputPrice"), { target: { value: "x" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				outputPrice: openAiModelInfoSaneDefaults.outputPrice,
			})
		})

		it("falls back to the sane defaults when editing without stored model info", () => {
			const { setApiConfigurationField } = renderProvider()

			fireEvent.change(field("settings:placeholders.numbers.contextWindow"), { target: { value: "2000" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				contextWindow: 2000,
			})

			fireEvent.change(field("settings:placeholders.numbers.inputPrice"), { target: { value: "1.5" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				inputPrice: 1.5,
			})

			fireEvent.change(field("settings:placeholders.numbers.outputPrice"), { target: { value: "2.5" } })
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCustomModelInfo", {
				...openAiModelInfoSaneDefaults,
				outputPrice: 2.5,
			})
		})

		it("restores the sane defaults", () => {
			const { setApiConfigurationField } = renderProvider({
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, maxTokens: 1 },
			})

			fireEvent.click(screen.getByText("settings:providers.customModel.resetDefaults"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", openAiModelInfoSaneDefaults)
		})
	})
})
