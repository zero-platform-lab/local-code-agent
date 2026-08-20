// npx vitest run src/components/chat/__tests__/CodeIndexPopover.spec.tsx

import React from "react"
import { render, screen, fireEvent, act, within } from "@/utils/test-utils"

import { type IndexingStatus, CODEBASE_INDEX_DEFAULTS } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"

import { CodeIndexPopover } from "../CodeIndexPopover"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const translate = (key: string) => key

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: translate }),
}))

const extensionState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState.current,
}))

vi.mock("@src/components/ui/hooks/useAgentPortal", () => ({ useAgentPortal: () => null }))

vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return { ...actual, Trans: ({ children }: any) => <>{children}</> }
})

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, title }: any) => (
		<button onClick={onClick} data-testid={`icon-button-${title}`}>
			{children}
		</button>
	),
	VSCodeTextField: ({ value, onInput, onBlur, placeholder, className, type }: any) => (
		<input
			type={type === "password" ? "password" : "text"}
			value={value}
			placeholder={placeholder}
			className={className}
			data-testid={`field-${placeholder}`}
			onChange={(event) => onInput({ target: { value: event.target.value } })}
			onBlur={(event) => onBlur?.({ target: { value: event.target.value } })}
		/>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			{children}
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
			/>
		</label>
	),
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	const { createContext, useContext } = await import("react")
	const OpenContext = createContext(false)

	return {
		...actual,
		Popover: ({ children, open, onOpenChange }: any) => (
			<OpenContext.Provider value={open}>
				<div data-testid="popover" data-open={String(open)}>
					<button data-testid="popover-open" onClick={() => onOpenChange(true)} />
					<button data-testid="popover-close" onClick={() => onOpenChange(false)} />
					{children}
				</div>
			</OpenContext.Provider>
		),
		PopoverContent: ({ children }: any) => {
			const open = useContext(OpenContext)
			return open ? <div data-testid="popover-content">{children}</div> : null
		},
		Slider: ({ value, onValueChange, min, max, step, "data-testid": testId }: any) => (
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value[0]}
				data-testid={testId}
				onChange={(event) => onValueChange([Number(event.target.value)])}
			/>
		),
		Button: ({ children, onClick, disabled, variant }: any) => (
			<button onClick={onClick} disabled={disabled} data-variant={variant}>
				{children}
			</button>
		),
		StandardTooltip: ({ children }: any) => <>{children}</>,
		AlertDialog: ({ children, open, onOpenChange }: any) => (
			<div data-testid="alert-dialog" data-open={String(open ?? "trigger")}>
				{onOpenChange ? (
					<button data-testid="alert-dialog-dismiss" onClick={() => onOpenChange(false)} />
				) : null}
				{open === false ? null : children}
			</div>
		),
		AlertDialogTrigger: ({ children }: any) => <div>{children}</div>,
		AlertDialogContent: ({ children }: any) => <div>{children}</div>,
		AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
		AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
		AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
		AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
		AlertDialogCancel: ({ children, onClick }: any) => (
			<button onClick={onClick} data-testid="alert-cancel">
				{children}
			</button>
		),
		AlertDialogAction: ({ children, onClick }: any) => (
			<button onClick={onClick} data-testid="alert-action">
				{children}
			</button>
		),
	}
})

const status = (overrides: Partial<IndexingStatus> = {}): IndexingStatus =>
	({
		systemStatus: "Standby",
		message: "",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "items",
		...overrides,
	}) as IndexingStatus

const fullConfig = {
	codebaseIndexEnabled: true,
	codebaseIndexQdrantUrl: "http://localhost:6333",
	codebaseIndexEmbedderModelId: "text-embedding-3-small",
	codebaseIndexEmbedderModelDimension: 1536,
	codebaseIndexSearchMaxResults: 20,
	codebaseIndexSearchMinScore: 0.6,
	codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.test/v1",
}

const renderPopover = (
	{ config, indexingStatus }: { config?: Record<string, unknown>; indexingStatus?: IndexingStatus } = {},
	open = true,
) => {
	extensionState.current = { codebaseIndexConfig: config, cwd: "/workspace" }
	const utils = render(
		<CodeIndexPopover indexingStatus={indexingStatus ?? status()}>
			<button data-testid="trigger">open</button>
		</CodeIndexPopover>,
	)
	if (open) {
		fireEvent.click(screen.getByTestId("popover-open"))
	}
	return utils
}

const posted = () => (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message)

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

const field = (placeholder: string) => screen.getByTestId(`field-${placeholder}`)

const BASE_URL = "settings:codeIndex.openAiCompatibleBaseUrlPlaceholder"
const API_KEY = "settings:codeIndex.openAiCompatibleApiKeyPlaceholder"
const MODEL_ID = "settings:codeIndex.modelPlaceholder"
const DIMENSION = "settings:codeIndex.modelDimensionPlaceholder"
const QDRANT_URL = "settings:codeIndex.qdrantUrlPlaceholder"
const QDRANT_KEY = "settings:codeIndex.qdrantApiKeyPlaceholder"

const openSetup = () => fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))
const openAdvanced = () => fireEvent.click(screen.getByText("settings:codeIndex.advancedConfigLabel"))
const saveButton = () => screen.getByText("settings:codeIndex.saveSettings").closest("button")!

describe("CodeIndexPopover", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("opening", () => {
		it("asks for the current status when it opens", () => {
			renderPopover({ config: fullConfig })

			expect(posted()).toContainEqual({ type: "requestIndexingStatus" })
			expect(posted()).toContainEqual({ type: "requestCodeIndexSecretStatus" })
			expect(screen.getByTestId("popover-content")).toBeInTheDocument()
		})

		it("stays closed until asked", () => {
			renderPopover({ config: fullConfig }, false)

			expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument()
			expect(posted()).not.toContainEqual({ type: "requestIndexingStatus" })
		})

		it("refreshes when the workspace changes while open", () => {
			renderPopover({ config: fullConfig })
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			post({ type: "workspaceUpdated" })

			expect(posted()).toContainEqual({ type: "requestIndexingStatus" })
		})

		it("ignores workspace changes while closed", () => {
			renderPopover({ config: fullConfig }, false)
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			post({ type: "workspaceUpdated" })

			expect(posted()).toHaveLength(0)
		})

		it("works without any stored configuration", () => {
			renderPopover({})

			expect(screen.getByTestId("popover-content")).toBeInTheDocument()
			// 保存済み設定が無いので初期化はされないが、開いたことによる問い合わせは飛ぶ。
			expect(posted().filter((message) => message.type === "requestCodeIndexSecretStatus")).toHaveLength(1)
		})
	})

	describe("status", () => {
		it("shows the progress while indexing", () => {
			renderPopover({
				config: fullConfig,
				indexingStatus: status({ systemStatus: "Indexing", processedItems: 5, totalItems: 20 }),
			})

			expect(screen.getByText(/settings:codeIndex.indexingStatuses.indexing/)).toBeInTheDocument()
			expect(document.querySelector('[style*="translateX(-75%)"]')).toBeInTheDocument()
		})

		it("keeps the bar empty when nothing is known yet", () => {
			renderPopover({
				config: fullConfig,
				indexingStatus: status({ systemStatus: "Indexing", processedItems: 0, totalItems: 0 }),
			})

			expect(document.querySelector('[style*="translateX(-100%)"]')).toBeInTheDocument()
		})

		it("appends the message the extension sent", () => {
			renderPopover({ config: fullConfig, indexingStatus: status({ message: "waiting" }) })

			expect(screen.getByText(/- waiting/)).toBeInTheDocument()
		})

		it("adopts a status update for this workspace", () => {
			renderPopover({ config: fullConfig })

			post({
				type: "indexingStatusUpdate",
				values: { systemStatus: "Indexed", message: "done", processedItems: 3, totalItems: 3 },
			})

			expect(screen.getByText(/settings:codeIndex.indexingStatuses.indexed/)).toBeInTheDocument()
		})

		it("adopts a status update addressed to this workspace path", () => {
			renderPopover({ config: fullConfig })

			post({
				type: "indexingStatusUpdate",
				values: { systemStatus: "Error", workspacePath: "/workspace", currentItemUnit: "files" },
			})

			expect(screen.getByText(/settings:codeIndex.indexingStatuses.error/)).toBeInTheDocument()
		})

		it("ignores a status update for another workspace", () => {
			renderPopover({ config: fullConfig })

			post({ type: "indexingStatusUpdate", values: { systemStatus: "Indexed", workspacePath: "/elsewhere" } })

			expect(screen.getByText(/settings:codeIndex.indexingStatuses.standby/)).toBeInTheDocument()
		})

		it("follows the status handed down by the parent", () => {
			const { rerender } = renderPopover({ config: fullConfig })

			rerender(
				<CodeIndexPopover indexingStatus={status({ systemStatus: "Indexed" })}>
					<button data-testid="trigger">open</button>
				</CodeIndexPopover>,
			)

			expect(screen.getByText(/settings:codeIndex.indexingStatuses.indexed/)).toBeInTheDocument()
		})
	})

	describe("settings form", () => {
		it("fills the fields from the stored configuration", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			expect(field(BASE_URL)).toHaveValue("https://api.example.test/v1")
			expect(field(MODEL_ID)).toHaveValue("text-embedding-3-small")
			expect(field(DIMENSION)).toHaveValue("1536")
			expect(field(QDRANT_URL)).toHaveValue("http://localhost:6333")
		})

		it("falls back to empty fields and default search settings", () => {
			renderPopover({ config: { codebaseIndexEnabled: false } })
			openSetup()
			openAdvanced()

			expect(field(BASE_URL)).toHaveValue("")
			expect(field(MODEL_ID)).toHaveValue("")
			expect(field(DIMENSION)).toHaveValue("")
			expect(screen.getByTestId("search-min-score-slider")).toHaveValue(
				String(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE),
			)
			expect(screen.getByTestId("search-max-results-slider")).toHaveValue(
				String(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS),
			)
		})

		it("enables the index by default when the flag is missing", () => {
			renderPopover({ config: { codebaseIndexQdrantUrl: "http://localhost:6333" } })

			expect(screen.getByRole("checkbox", { name: /enableLabel/ })).toBeChecked()
		})

		it("toggles the setup and advanced sections", () => {
			renderPopover({ config: fullConfig })

			expect(screen.queryByTestId(`field-${BASE_URL}`)).not.toBeInTheDocument()
			openSetup()
			expect(screen.getByTestId(`field-${BASE_URL}`)).toBeInTheDocument()
			openSetup()
			expect(screen.queryByTestId(`field-${BASE_URL}`)).not.toBeInTheDocument()

			openAdvanced()
			expect(screen.getByTestId("search-min-score-slider")).toBeInTheDocument()
			openAdvanced()
			expect(screen.queryByTestId("search-min-score-slider")).not.toBeInTheDocument()
		})

		it("moves and resets the sliders", () => {
			renderPopover({ config: fullConfig })
			openAdvanced()

			fireEvent.change(screen.getByTestId("search-min-score-slider"), { target: { value: "0.8" } })
			expect(screen.getByText("0.80")).toBeInTheDocument()

			fireEvent.change(screen.getByTestId("search-max-results-slider"), { target: { value: "100" } })
			expect(screen.getByText("100")).toBeInTheDocument()

			const resets = screen.getAllByTestId("icon-button-settings:codeIndex.resetToDefault")
			fireEvent.click(resets[0])
			fireEvent.click(resets[1])

			expect(screen.getByText(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE.toFixed(2))).toBeInTheDocument()
			expect(screen.getByText(String(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS))).toBeInTheDocument()
		})
	})

	describe("saving", () => {
		const fillValidSettings = () => {
			openSetup()
			fireEvent.change(field(BASE_URL), { target: { value: "https://api.example.test/v1" } })
			fireEvent.change(field(API_KEY), { target: { value: "sk-test" } })
			fireEvent.change(field(MODEL_ID), { target: { value: "text-embedding-3-small" } })
			fireEvent.change(field(DIMENSION), { target: { value: "1536" } })
			fireEvent.change(field(QDRANT_URL), { target: { value: "http://localhost:6333" } })
		}

		it("stays disabled until something changes", () => {
			renderPopover({ config: fullConfig })

			expect(saveButton()).toBeDisabled()

			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "another-model" } })

			expect(saveButton()).toBeEnabled()
		})

		it("sends every setting that is not a placeholder", () => {
			renderPopover({ config: {} })
			fillValidSettings()

			fireEvent.click(saveButton())

			expect(posted()).toContainEqual({
				type: "saveCodeIndexSettingsAtomic",
				codeIndexSettings: expect.objectContaining({
					codebaseIndexEnabled: true,
					codebaseIndexQdrantUrl: "http://localhost:6333",
					codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.test/v1",
					codebaseIndexOpenAiCompatibleApiKey: "sk-test",
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderModelDimension: 1536,
				}),
			})
		})

		it("refuses to save an incomplete configuration", () => {
			renderPopover({ config: {} })
			openSetup()
			fireEvent.change(field(API_KEY), { target: { value: "sk-test" } })

			fireEvent.click(saveButton())

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "saveCodeIndexSettingsAtomic" }))
			expect(screen.getByText("settings:codeIndex.validation.modelIdRequired")).toBeInTheDocument()
			// 空欄は「未入力」と「URL として不正」の両方に当たり、後者が表示される。
			expect(screen.getByText("settings:codeIndex.validation.invalidQdrantUrl")).toBeInTheDocument()
			expect(screen.getByText("settings:codeIndex.validation.invalidBaseUrl")).toBeInTheDocument()
			// 次元は未入力そのものが弾かれる（zod の既定文言）。
			expect(document.querySelectorAll("p.text-vscode-errorForeground").length).toBeGreaterThanOrEqual(4)
		})

		it("rejects malformed urls", () => {
			renderPopover({ config: {} })
			fillValidSettings()
			fireEvent.change(field(QDRANT_URL), { target: { value: "not a url" } })
			fireEvent.change(field(BASE_URL), { target: { value: "also not a url" } })

			fireEvent.click(saveButton())

			expect(screen.getByText("settings:codeIndex.validation.invalidQdrantUrl")).toBeInTheDocument()
			expect(screen.getByText("settings:codeIndex.validation.invalidBaseUrl")).toBeInTheDocument()
		})

		it("clears the error of a field as soon as it is edited", () => {
			renderPopover({ config: {} })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "m" } })
			fireEvent.click(saveButton())
			expect(screen.getByText("settings:codeIndex.validation.invalidQdrantUrl")).toBeInTheDocument()

			fireEvent.change(field(QDRANT_URL), { target: { value: "h" } })

			expect(screen.queryByText("settings:codeIndex.validation.invalidQdrantUrl")).not.toBeInTheDocument()
			// 触っていない側の指摘は残る。
			expect(screen.getByText("settings:codeIndex.validation.invalidBaseUrl")).toBeInTheDocument()
		})

		it("falls back to the local qdrant when the field is left empty", () => {
			renderPopover({ config: {} })
			openSetup()

			// React 18 の onBlur は focusout として届く。
			fireEvent.focusOut(field(QDRANT_URL), { target: { value: "  " } })

			expect(field(QDRANT_URL)).toHaveValue("http://localhost:6333")
		})

		it("keeps what the user typed on blur", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			fireEvent.focusOut(field(QDRANT_URL), { target: { value: "http://example.test" } })

			expect(field(QDRANT_URL)).toHaveValue("http://example.test")
		})

		it("keeps the stored secrets when the placeholder is left untouched", () => {
			renderPopover({ config: fullConfig })
			post({ type: "codeIndexSecretStatus", values: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: true } })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "another-model" } })

			fireEvent.click(saveButton())

			const saved = posted().find((message) => message.type === "saveCodeIndexSettingsAtomic")!
			expect(saved.codeIndexSettings).not.toHaveProperty("codebaseIndexOpenAiCompatibleApiKey")
			expect(saved.codeIndexSettings).not.toHaveProperty("codeIndexQdrantApiKey")
		})

		it("marks the settings as saved once the extension confirms", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "another-model" } })
			expect(saveButton()).toBeEnabled()

			post({ type: "codeIndexSettingsSaved", success: true })

			expect(saveButton()).toBeDisabled()
			expect(posted()).toContainEqual({ type: "requestCodeIndexSecretStatus" })
		})

		it("shows the failure and clears it after a while", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderPopover({ config: fullConfig })

				post({ type: "codeIndexSettingsSaved", success: false, error: "backend exploded" })
				expect(screen.getByText("backend exploded")).toBeInTheDocument()

				act(() => vi.advanceTimersByTime(5000))
				expect(screen.queryByText("backend exploded")).not.toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})

		it("falls back to a generic failure message", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderPopover({ config: fullConfig })

				post({ type: "codeIndexSettingsSaved", success: false })

				expect(screen.getAllByText("settings:codeIndex.saveError").length).toBeGreaterThan(0)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("secret placeholders", () => {
		it("shows a placeholder for the secrets that already exist", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			post({ type: "codeIndexSecretStatus", values: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: true } })

			expect(field(API_KEY)).toHaveValue("••••••••••••••••")
			expect(field(QDRANT_KEY)).toHaveValue("••••••••••••••••")
			expect(saveButton()).toBeDisabled()
		})

		it("clears the boxes when no secret is stored", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			post({ type: "codeIndexSecretStatus", values: {} })

			expect(field(API_KEY)).toHaveValue("")
			expect(field(QDRANT_KEY)).toHaveValue("")
		})

		it("does not overwrite what the user is typing", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(API_KEY), { target: { value: "sk-typing" } })

			post({ type: "codeIndexSecretStatus", values: { hasOpenAiCompatibleApiKey: true } })

			expect(field(API_KEY)).toHaveValue("sk-typing")
		})
	})

	describe("indexing actions", () => {
		it("starts indexing from standby", () => {
			renderPopover({ config: fullConfig })

			fireEvent.click(screen.getByText("settings:codeIndex.startIndexingButton"))

			expect(posted()).toContainEqual({ type: "startIndexing" })
		})

		it("stops a run in progress", () => {
			renderPopover({ config: fullConfig, indexingStatus: status({ systemStatus: "Indexing" }) })

			fireEvent.click(screen.getByText("settings:codeIndex.stopIndexingButton"))

			expect(posted()).toContainEqual({ type: "stopIndexing" })
		})

		it("shows a disabled button while stopping", () => {
			renderPopover({ config: fullConfig, indexingStatus: status({ systemStatus: "Stopping" }) })

			expect(screen.getByText("settings:codeIndex.stoppingButton").closest("button")).toBeDisabled()
		})

		it("clears the index data after confirmation", () => {
			renderPopover({ config: fullConfig, indexingStatus: status({ systemStatus: "Indexed" }) })

			const clearDialog = screen
				.getAllByTestId("alert-dialog")
				.find((dialog) => dialog.textContent?.includes("settings:codeIndex.clearDataDialog.title"))!
			fireEvent.click(within(clearDialog).getByTestId("alert-action"))

			expect(posted()).toContainEqual({ type: "clearIndexData" })
		})

		it("hides the actions when indexing is switched off", () => {
			renderPopover({ config: { ...fullConfig, codebaseIndexEnabled: false } })

			expect(screen.queryByText("settings:codeIndex.startIndexingButton")).not.toBeInTheDocument()
			expect(screen.queryByText("settings:codeIndex.workspaceToggleLabel")).not.toBeInTheDocument()
		})

		it("toggles the workspace and the default", () => {
			renderPopover({ config: fullConfig })

			fireEvent.click(screen.getByLabelText("settings:codeIndex.workspaceToggleLabel"))
			expect(posted()).toContainEqual({ type: "toggleWorkspaceIndexing", bool: true })

			fireEvent.click(screen.getByLabelText("settings:codeIndex.autoEnableDefaultLabel"))
			expect(posted()).toContainEqual({ type: "setAutoEnableDefault", bool: false })
		})

		it("explains that this workspace is not indexed", () => {
			renderPopover({ config: fullConfig })

			expect(screen.getByText("settings:codeIndex.workspaceDisabledMessage")).toBeInTheDocument()
		})

		it("hides the explanation once the workspace is indexed", () => {
			renderPopover({
				config: fullConfig,
				indexingStatus: status({ workspaceEnabled: true, autoEnableDefault: false } as Partial<IndexingStatus>),
			})

			expect(screen.queryByText("settings:codeIndex.workspaceDisabledMessage")).not.toBeInTheDocument()
			expect(screen.getByLabelText("settings:codeIndex.workspaceToggleLabel")).toBeChecked()
			expect(screen.getByLabelText("settings:codeIndex.autoEnableDefaultLabel")).not.toBeChecked()
		})
	})

	describe("more wiring", () => {
		it("turns the index off", () => {
			renderPopover({ config: fullConfig })

			fireEvent.click(screen.getByRole("checkbox", { name: /enableLabel/ }))

			expect(screen.getByRole("checkbox", { name: /enableLabel/ })).not.toBeChecked()
			expect(screen.queryByText("settings:codeIndex.startIndexingButton")).not.toBeInTheDocument()
		})

		it("keeps the dimension empty when the input is not a number", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			fireEvent.change(field(DIMENSION), { target: { value: "abc" } })
			expect(field(DIMENSION)).toHaveValue("")

			fireEvent.change(field(DIMENSION), { target: { value: "768" } })
			expect(field(DIMENSION)).toHaveValue("768")

			fireEvent.change(field(DIMENSION), { target: { value: "" } })
			expect(field(DIMENSION)).toHaveValue("")
		})

		it("stores the qdrant api key", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			fireEvent.change(field(QDRANT_KEY), { target: { value: "qdrant-secret" } })

			expect(field(QDRANT_KEY)).toHaveValue("qdrant-secret")
			expect(saveButton()).toBeEnabled()
		})

		it("restarts the countdown when a second failure arrives", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderPopover({ config: fullConfig })

				post({ type: "codeIndexSettingsSaved", success: false, error: "first" })
				act(() => vi.advanceTimersByTime(4000))
				post({ type: "codeIndexSettingsSaved", success: false, error: "second" })

				act(() => vi.advanceTimersByTime(2000))
				expect(screen.getByText("second")).toBeInTheDocument()

				act(() => vi.advanceTimersByTime(3000))
				expect(screen.queryByText("second")).not.toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})

		it("keeps the placeholder when the secret status arrives twice", () => {
			renderPopover({ config: fullConfig })
			openSetup()

			post({ type: "codeIndexSecretStatus", values: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: true } })
			post({ type: "codeIndexSecretStatus", values: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: true } })

			expect(field(QDRANT_KEY)).toHaveValue("••••••••••••••••")
			expect(field(API_KEY)).toHaveValue("••••••••••••••••")
		})

		it("ignores the secret status while a save is in flight", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(API_KEY), { target: { value: "sk-test" } })
			fireEvent.click(saveButton())
			expect(posted()).toContainEqual(expect.objectContaining({ type: "saveCodeIndexSettingsAtomic" }))

			post({ type: "codeIndexSecretStatus", values: { hasQdrantApiKey: true } })

			expect(field(QDRANT_KEY)).toHaveValue("")
		})
	})

	describe("unsaved changes", () => {
		it("closes straight away when nothing changed", () => {
			renderPopover({ config: fullConfig })

			fireEvent.click(screen.getByTestId("popover-close"))

			expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument()
		})

		it("asks before dropping the changes", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "changed" } })

			fireEvent.click(screen.getByTestId("popover-close"))

			expect(screen.getByTestId("popover-content")).toBeInTheDocument()
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})

		it("keeps the changes when the user cancels", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "changed" } })
			fireEvent.click(screen.getByTestId("popover-close"))

			fireEvent.click(within(screen.getAllByTestId("alert-dialog")[0]).getByTestId("alert-cancel"))

			expect(field(MODEL_ID)).toHaveValue("changed")
			expect(screen.getByTestId("popover-content")).toBeInTheDocument()
		})

		it("drops the changes and closes when confirmed", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "changed" } })
			fireEvent.click(screen.getByTestId("popover-close"))

			fireEvent.click(within(screen.getAllByTestId("alert-dialog")[0]).getByTestId("alert-action"))

			expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument()

			// 開き直すと編集前の値に戻っている（設定セクションは開いたまま）。
			fireEvent.click(screen.getByTestId("popover-open"))
			expect(field(MODEL_ID)).toHaveValue("text-embedding-3-small")
		})

		it("closes the question on escape", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "changed" } })
			fireEvent.click(screen.getByTestId("popover-close"))

			fireEvent.click(screen.getByTestId("alert-dialog-dismiss"))

			expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
		})

		it("checks for unsaved changes when escape closes the popover", () => {
			renderPopover({ config: fullConfig })
			openSetup()
			fireEvent.change(field(MODEL_ID), { target: { value: "changed" } })

			fireEvent.keyDown(document, { key: "Escape" })

			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})
	})
})
