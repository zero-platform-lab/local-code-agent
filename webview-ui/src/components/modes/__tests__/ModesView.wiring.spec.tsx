// npx vitest run src/components/modes/__tests__/ModesView.wiring.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { ModeConfig } from "@openai-agent/types"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ModesView from "../ModesView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// Radix の Select は jsdom でポインタ操作を再現できないので、選択だけを取り出す。
vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	const { createContext, useContext } = await import("react")
	const SelectContext = createContext<(value: string) => void>(() => {})

	return {
		...actual,
		Select: ({ children, value, onValueChange }: any) => (
			<SelectContext.Provider value={onValueChange}>
				<div data-testid="api-config-select" data-value={value}>
					{children}
				</div>
			</SelectContext.Provider>
		),
		SelectContent: ({ children }: any) => <div>{children}</div>,
		SelectTrigger: ({ children }: any) => <div>{children}</div>,
		SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
		SelectItem: ({ children, value }: any) => {
			const onValueChange = useContext(SelectContext)
			return (
				<button data-testid={`api-config-${value}`} onClick={() => onValueChange(value)}>
					{children}
				</button>
			)
		},
	}
})

// 翻訳リソースを読み込まないテストでは Trans が components を描画しないため、
// 「components に渡した要素を描画する」という最小の振る舞いに差し替える。
vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		Trans: ({ i18nKey, components, children }: any) => (
			<span data-testid={`trans-${i18nKey}`}>
				{children}
				{components ? Object.values(components) : null}
			</span>
		),
	}
})

Element.prototype.scrollIntoView = vi.fn()

/** カスタム要素は値をプロパティで受け取るので、属性ではなくそちらを見る。 */
const valueOf = (element: Element) => (element as unknown as { value: string }).value

const customMode: ModeConfig = {
	slug: "custom-mode",
	name: "Custom Mode",
	roleDefinition: "Custom role",
	groups: ["read"],
	source: "global",
} as ModeConfig

const baseState = {
	customModePrompts: {},
	listApiConfigMeta: [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	],
	mode: "code",
	customModes: [] as ModeConfig[],
	currentApiConfigName: "Config 1",
	customInstructions: "Initial instructions",
	setCustomInstructions: vi.fn(),
}

const renderModes = (props: Record<string, unknown> = {}) =>
	render(
		<ExtensionStateContext.Provider value={{ ...baseState, ...props } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)

const posted = () => (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message)

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

/** 設定メニューのトグル（codicon-json のアイコンボタン）。 */
const configMenuToggle = () => document.querySelector(".codicon-json")!.closest("button")!

const change = (element: Element, value: string) => {
	fireEvent(element, new CustomEvent("change", { detail: { target: { value } } }))
}

/** FAST の text-field は `e.target.value` を読むので、要素に値を生やしてから input を発火する。 */
const input = (element: Element, value: string) => {
	Object.defineProperty(element, "value", { value, writable: true, configurable: true })
	fireEvent(element, new Event("input", { bubbles: true }))
}

describe("ModesView wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("config menu", () => {
		it("opens the global and project mode files", () => {
			renderModes()

			const toggle = configMenuToggle()
			expect(screen.queryByText("prompts:modes.editGlobalModes")).not.toBeInTheDocument()

			fireEvent.click(toggle)
			fireEvent.mouseDown(screen.getByText("prompts:modes.editGlobalModes"))
			expect(posted()).toContainEqual({ type: "openCustomModesSettings" })

			fireEvent.click(toggle)
			fireEvent.mouseDown(screen.getByText("prompts:modes.editProjectModes"))
			expect(posted()).toContainEqual({
				type: "openFile",
				text: "./.agentmodes",
				values: { create: true, content: JSON.stringify({ customModes: [] }, null, 2) },
			})
		})

		it("closes when the user clicks elsewhere", () => {
			renderModes()

			fireEvent.click(configMenuToggle())
			expect(screen.getByText("prompts:modes.editGlobalModes")).toBeInTheDocument()

			fireEvent.click(document.body)

			expect(screen.queryByText("prompts:modes.editGlobalModes")).not.toBeInTheDocument()
		})

		it("closes shortly after losing focus", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderModes()
				const toggle = configMenuToggle()

				fireEvent.click(toggle)
				fireEvent.blur(toggle)
				expect(screen.getByText("prompts:modes.editGlobalModes")).toBeInTheDocument()

				act(() => vi.advanceTimersByTime(200))
				expect(screen.queryByText("prompts:modes.editGlobalModes")).not.toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("rename", () => {
		it("is only offered for custom modes", () => {
			renderModes()
			expect(screen.getByTestId("rename-mode-button")).toBeDisabled()

			renderModes({ mode: "custom-mode", customModes: [customMode] })
			expect(screen.getAllByTestId("rename-mode-button")[1]).toBeEnabled()
		})

		it("saves a new name and reflects it immediately", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("rename-mode-button"))
			const field = document.querySelector("vscode-text-field")!
			input(field, "Renamed Mode")

			fireEvent.click(screen.getByTestId("save-mode-rename-button"))

			expect(posted()).toContainEqual({
				type: "updateCustomMode",
				slug: "custom-mode",
				modeConfig: { ...customMode, name: "Renamed Mode", source: "global" },
			})
			expect(screen.getByTestId("mode-select-trigger")).toHaveTextContent("Renamed Mode")
		})

		it("refuses a name that another mode already uses", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("rename-mode-button"))
			// 組み込みモードと同じ名前（大文字小文字は無視される）。
			input(document.querySelector("vscode-text-field")!, "💻 code")
			fireEvent.click(screen.getByTestId("save-mode-rename-button"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "updateCustomMode" }))
			expect(screen.getByTestId("save-mode-rename-button")).toBeInTheDocument()
		})

		it("just leaves rename mode when the name is blank", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("rename-mode-button"))
			input(document.querySelector("vscode-text-field")!, "   ")
			// 空白だけのときは保存ボタンが無効なので、コンポーネント側の早期 return を直接踏む
			expect(screen.getByTestId("save-mode-rename-button")).toBeDisabled()

			fireEvent.click(screen.getByTestId("cancel-mode-rename-button"))
			expect(screen.queryByTestId("save-mode-rename-button")).not.toBeInTheDocument()
		})

		it("focuses the rename field", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderModes({ mode: "custom-mode", customModes: [customMode] })

				fireEvent.click(screen.getByTestId("rename-mode-button"))
				act(() => vi.advanceTimersByTime(1))

				expect(document.querySelector("vscode-text-field")).toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("delete", () => {
		it("is only offered for custom modes", () => {
			renderModes()

			expect(screen.getByTestId("delete-mode-button")).toBeDisabled()
		})

		it("asks the extension to check before confirming", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("delete-mode-button"))
			expect(posted()).toContainEqual({ type: "deleteCustomMode", slug: "custom-mode", checkOnly: true })

			post({ type: "deleteCustomModeCheck", slug: "custom-mode", rulesFolderPath: ".agent/rules-custom-mode" })

			expect(screen.getByTestId("delete-mode-confirm")).toBeInTheDocument()
			// 規則フォルダがあるときだけ追加の注意書きが出る。
			expect(document.body.textContent).toContain("prompts:deleteMode.rulesFolder")
		})

		it("ignores a check answer for another mode", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("delete-mode-button"))
			post({ type: "deleteCustomModeCheck", slug: "someone-else" })

			expect(screen.queryByTestId("delete-mode-confirm")).not.toBeInTheDocument()
		})

		it("deletes the mode once confirmed", () => {
			renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("delete-mode-button"))
			post({ type: "deleteCustomModeCheck", slug: "custom-mode" })
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			fireEvent.click(screen.getByTestId("delete-mode-confirm"))

			expect(posted()).toContainEqual({ type: "deleteCustomMode", slug: "custom-mode" })
		})
	})

	describe("export and import", () => {
		it("exports the current mode once at a time", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("export-mode-toolbar-button"))
			expect(posted()).toContainEqual({ type: "exportMode", slug: "code" })
			expect(screen.getByTestId("export-mode-toolbar-button")).toBeDisabled()

			post({ type: "exportModeResult", success: true })
			expect(screen.getByTestId("export-mode-toolbar-button")).toBeEnabled()
		})

		it("reports an export failure", () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			renderModes()

			fireEvent.click(screen.getByTestId("export-mode-toolbar-button"))
			post({ type: "exportModeResult", success: false, error: "disk full" })

			expect(error).toHaveBeenCalledWith("Failed to export mode:", "disk full")
			error.mockRestore()
		})

		it("imports a mode and switches to it", () => {
			const imported = { ...customMode, slug: "imported", name: "Imported" } as ModeConfig
			renderModes({ customModes: [imported] })

			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			fireEvent.click(screen.getByTestId("import-mode-button"))
			expect(posted()).toContainEqual({ type: "importMode", source: "project" })

			// 実行中の二重送信は無視される。
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()
			fireEvent.click(screen.getByTestId("import-mode-button"))
			expect(posted()).toHaveLength(0)

			post({ type: "importModeResult", success: true, slug: "imported" })

			expect(posted()).toContainEqual({ type: "mode", text: "imported" })
			expect(screen.queryByTestId("import-mode-button")).not.toBeInTheDocument()
		})

		it("falls back to the default mode when the imported slug is not known yet", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			fireEvent.click(screen.getByTestId("import-mode-button"))
			post({ type: "importModeResult", success: true, slug: "not-in-state" })

			expect(posted()).toContainEqual({ type: "mode", text: "code" })
			expect(screen.getByTestId("mode-select-trigger")).toHaveTextContent("💻 Code")
		})

		it("does nothing when the import result carries no slug", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			fireEvent.click(screen.getByTestId("import-mode-button"))
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()
			post({ type: "importModeResult", success: true })

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "mode" }))
		})

		it("reports an import failure but stays quiet on cancellation", () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			renderModes()

			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			post({ type: "importModeResult", success: false, error: "broken file" })
			expect(error).toHaveBeenCalledWith("Failed to import mode:", "broken file")

			error.mockClear()
			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			post({ type: "importModeResult", success: false, error: "cancelled" })
			expect(error).not.toHaveBeenCalled()

			error.mockRestore()
		})

		it("closes the import dialog", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("import-mode-toolbar-button"))
			fireEvent.click(screen.getByTestId("cancel-import-button"))

			expect(screen.queryByTestId("import-mode-button")).not.toBeInTheDocument()
		})
	})

	describe("rules directory", () => {
		it("asks once per mode and remembers the answer", () => {
			renderModes()

			expect(posted()).toContainEqual({ type: "checkRulesDirectory", slug: "code" })
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			post({ type: "checkRulesDirectoryResult", slug: "code", hasContent: true })

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "checkRulesDirectory" }))
		})
	})

	describe("mode fields", () => {
		const custom = { mode: "custom-mode", customModes: [customMode] }

		it("shows the built-in defaults and writes prompt overrides", () => {
			renderModes()

			change(screen.getByTestId("code-prompt-textarea"), "  new role  ")
			expect(posted()).toContainEqual({
				type: "updatePrompt",
				promptMode: "code",
				customPrompt: { roleDefinition: "new role" },
			})

			change(screen.getByTestId("code-description-textfield"), "new description")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updatePrompt",
					customPrompt: expect.objectContaining({ description: "new description" }),
				}),
			)

			change(screen.getByTestId("code-when-to-use-textarea"), "when to use")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updatePrompt",
					customPrompt: expect.objectContaining({ whenToUse: "when to use" }),
				}),
			)

			change(screen.getByTestId("code-custom-instructions-textarea"), "extra rules")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updatePrompt",
					customPrompt: expect.objectContaining({ customInstructions: "extra rules" }),
				}),
			)
		})

		it("clears a built-in override when the field is emptied", () => {
			renderModes({ customModePrompts: { code: { roleDefinition: "stored" } } })

			change(screen.getByTestId("code-prompt-textarea"), "   ")

			expect(posted()).toContainEqual({
				type: "updatePrompt",
				promptMode: "code",
				customPrompt: { roleDefinition: undefined },
			})
		})

		it("writes the custom mode file instead of an override", () => {
			renderModes(custom)

			change(screen.getByTestId("custom-mode-prompt-textarea"), " updated role ")
			expect(posted()).toContainEqual({
				type: "updateCustomMode",
				slug: "custom-mode",
				modeConfig: { ...customMode, roleDefinition: "updated role", source: "global" },
			})

			change(screen.getByTestId("custom-mode-description-textfield"), "desc")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ description: "desc" }),
				}),
			)

			change(screen.getByTestId("custom-mode-when-to-use-textarea"), "when")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ whenToUse: "when" }),
				}),
			)

			change(screen.getByTestId("custom-mode-custom-instructions-textarea"), "")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ customInstructions: "" }),
				}),
			)
		})

		it("keeps a custom mode without an explicit source on global", () => {
			const sourceless = { ...customMode, source: undefined } as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [sourceless] })

			change(screen.getByTestId("custom-mode-prompt-textarea"), "role")

			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ source: "global" }),
				}),
			)
		})

		it("reads a value straight off the event target when there is no detail", () => {
			renderModes()
			const textarea = screen.getByTestId("code-prompt-textarea")

			Object.defineProperty(textarea, "value", { value: "typed directly", writable: true, configurable: true })
			fireEvent(textarea, new Event("change", { bubbles: true }))

			expect(posted()).toContainEqual({
				type: "updatePrompt",
				promptMode: "code",
				customPrompt: { roleDefinition: "typed directly" },
			})
		})

		it("offers the resets only for built-in modes", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("role-definition-reset"))
			fireEvent.click(screen.getByTestId("description-reset"))
			fireEvent.click(screen.getByTestId("when-to-use-reset"))
			fireEvent.click(screen.getByTestId("custom-instructions-reset"))

			expect(posted().filter((message) => message.type === "updatePrompt")).toHaveLength(4)
		})

		it("hides the resets for custom modes", () => {
			renderModes(custom)

			expect(screen.queryByTestId("role-definition-reset")).not.toBeInTheDocument()
			expect(screen.queryByTestId("description-reset")).not.toBeInTheDocument()
			expect(screen.queryByTestId("when-to-use-reset")).not.toBeInTheDocument()
			expect(screen.queryByTestId("custom-instructions-reset")).not.toBeInTheDocument()
		})

		it("prefers the stored override over the built-in default", () => {
			renderModes({ customModePrompts: { code: { roleDefinition: "override" } } })

			expect(valueOf(screen.getByTestId("code-prompt-textarea"))).toBe("override")
		})

		it("opens the mode rules file", () => {
			renderModes()

			const spans = document.querySelectorAll("span.cursor-pointer")
			fireEvent.click(spans[0])

			expect(posted()).toContainEqual({
				type: "openFile",
				text: "./.agent/rules-code/rules.md",
				values: { create: true, content: "" },
			})
		})

		it("opens the global rules file", () => {
			renderModes()

			const spans = document.querySelectorAll("span.cursor-pointer")
			fireEvent.click(spans[spans.length - 1])

			expect(posted()).toContainEqual({
				type: "openFile",
				text: "./.agent/rules/rules.md",
				values: { create: true, content: "" },
			})
		})

		it("saves the global custom instructions", () => {
			const setCustomInstructions = vi.fn()
			renderModes({ setCustomInstructions })

			change(screen.getByTestId("global-custom-instructions-textarea"), "be terse")

			expect(setCustomInstructions).toHaveBeenCalledWith("be terse")
			expect(posted()).toContainEqual({ type: "customInstructions", text: "be terse" })
		})

		it("renders an empty box when there are no global instructions", () => {
			renderModes({ customInstructions: undefined })

			expect(valueOf(screen.getByTestId("global-custom-instructions-textarea"))).toBe("")
		})
	})

	describe("tools", () => {
		const custom = { mode: "custom-mode", customModes: [customMode] }

		const toolsEditButton = () => document.querySelectorAll(".codicon-edit")[1].closest("button")!

		it("explains that built-in modes cannot be edited", () => {
			renderModes()

			expect(screen.getByText("prompts:tools.builtInModesText")).toBeInTheDocument()
			expect(document.querySelectorAll(".codicon-edit")).toHaveLength(1)
		})

		it("lists the enabled groups of the current mode", () => {
			renderModes(custom)

			expect(screen.getByText("prompts:tools.toolNames.read")).toBeInTheDocument()
		})

		it("says so when a mode has no tools", () => {
			renderModes({ mode: "custom-mode", customModes: [{ ...customMode, groups: [] } as ModeConfig] })

			expect(screen.getByText("prompts:tools.noTools")).toBeInTheDocument()
		})

		it("describes the file restriction of the edit group", () => {
			const restricted = {
				...customMode,
				groups: ["read", ["edit", { fileRegex: "\\.md$", description: "Markdown only" }]],
			} as unknown as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [restricted] })

			expect(screen.getByText(/Markdown only/)).toBeInTheDocument()
		})

		it("falls back to the raw pattern when the restriction has no description", () => {
			const restricted = {
				...customMode,
				groups: ["read", ["edit", { fileRegex: "\\.md$" }]],
			} as unknown as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [restricted] })

			expect(screen.getByText(/\.md\$/)).toBeInTheDocument()
		})

		it("toggles a group on and off", () => {
			renderModes(custom)

			fireEvent.click(toolsEditButton())
			const checkboxes = document.querySelectorAll("vscode-checkbox")
			expect(checkboxes.length).toBeGreaterThan(0)

			fireEvent(checkboxes[0], new CustomEvent("change", { detail: { target: { checked: false } } }))
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ groups: [] }),
				}),
			)
		})

		it("shows the file restriction inside the editor too", () => {
			renderModes(custom)

			fireEvent.click(toolsEditButton())

			expect(screen.getByText(/prompts:allFiles/)).toBeInTheDocument()
		})

		it("leaves tools edit mode when the mode changes", () => {
			const second = { ...customMode, slug: "second", name: "Second" } as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [customMode, second] })

			fireEvent.click(toolsEditButton())
			expect(document.querySelectorAll("vscode-checkbox").length).toBeGreaterThan(0)

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.click(screen.getByTestId("mode-option-second"))

			expect(document.querySelectorAll("vscode-checkbox")).toHaveLength(0)
			expect(posted()).toContainEqual({ type: "mode", text: "second" })
		})
	})

	describe("create mode", () => {
		it("opens pre-filled with a unique name", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("add-mode-button"))

			const [name, slug] = screen.getAllByRole("textbox")
			expect(name).toHaveValue("New Custom Mode")
			expect(slug).toHaveValue("new-custom-mode")
		})

		it("proposes a name that is not taken yet", () => {
			renderModes({
				customModes: [{ ...customMode, slug: "new-custom-mode", name: "New Custom Mode" } as ModeConfig],
			})

			fireEvent.click(screen.getByTestId("add-mode-button"))

			expect(screen.getAllByRole("textbox")[0]).not.toHaveValue("New Custom Mode")
		})

		it("creates the mode", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("add-mode-button"))
			expect(screen.getByText("prompts:createModeDialog.title")).toBeInTheDocument()

			const dialog = screen.getByText("prompts:createModeDialog.title").closest("div.fixed")!
			const roleDefinition = dialog.querySelectorAll("vscode-text-area")[0]
			Object.defineProperty(roleDefinition, "value", {
				value: "You are a helper.",
				writable: true,
				configurable: true,
			})
			fireEvent(roleDefinition, new Event("change", { bubbles: true }))

			fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.create"))

			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					slug: "new-custom-mode",
				}),
			)
			expect(posted()).toContainEqual({ type: "mode", text: "new-custom-mode" })
			expect(screen.queryByText("prompts:createModeDialog.title")).not.toBeInTheDocument()
		})

		it("keeps the dialog open and reports the problem when the draft is invalid", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("add-mode-button"))
			const nameInput = screen.getAllByRole("textbox")[0]
			fireEvent.change(nameInput, { target: { value: "" } })

			fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.create"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "updateCustomMode" }))
			expect(screen.getByText("prompts:createModeDialog.title")).toBeInTheDocument()
			// どこが悪いのかを画面に出す。
			expect(document.querySelectorAll(".text-vscode-errorForeground").length).toBeGreaterThan(0)
		})

		it("starts from a clean draft each time it opens", () => {
			renderModes()
			const roleDefinitionField = () =>
				screen
					.getByText("prompts:createModeDialog.title")
					.closest("div.fixed")!
					.querySelectorAll("vscode-text-area")[0]

			fireEvent.click(screen.getByTestId("add-mode-button"))
			const field = roleDefinitionField()
			Object.defineProperty(field, "value", { value: "half typed", writable: true, configurable: true })
			fireEvent(field, new Event("change", { bubbles: true }))
			expect(valueOf(roleDefinitionField())).toBe("half typed")

			fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.cancel"))
			fireEvent.click(screen.getByTestId("add-mode-button"))

			expect(valueOf(roleDefinitionField())).toBe("")
			expect(screen.getAllByRole("textbox")[0]).toHaveValue("New Custom Mode")
		})

		it("derives the slug from the name", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("add-mode-button"))
			fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "My New Mode" } })

			expect(screen.getAllByRole("textbox")[1]).toHaveValue("my-new-mode")
		})

		it("closes without creating anything", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("add-mode-button"))
			fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.cancel"))

			expect(screen.queryByText("prompts:createModeDialog.title")).not.toBeInTheDocument()
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "updateCustomMode" }))
		})
	})

	describe("mode picker", () => {
		it("clears the search box from the clear button", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "ask" } })
			expect(screen.getByTestId("mode-search-input")).toHaveValue("ask")

			// クリアは検索欄の右端に出る X アイコン。
			fireEvent.click(document.querySelector("svg.cursor-pointer")!)

			expect(screen.getByTestId("mode-search-input")).toHaveValue("")
		})

		it("forgets the search shortly after closing", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderModes()

				fireEvent.click(screen.getByTestId("mode-select-trigger"))
				fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "ask" } })
				fireEvent.keyDown(document, { key: "Escape" })

				act(() => vi.advanceTimersByTime(100))

				fireEvent.click(screen.getByTestId("mode-select-trigger"))
				expect(screen.getByTestId("mode-search-input")).toHaveValue("")
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("edge cases", () => {
		const sourceless = { ...customMode, source: undefined } as ModeConfig

		it("gives up renaming when the mode disappears mid-edit", () => {
			const { rerender } = renderModes({ mode: "custom-mode", customModes: [customMode] })

			fireEvent.click(screen.getByTestId("rename-mode-button"))
			input(document.querySelector("vscode-text-field")!, "Renamed")

			// 拡張側でモードが消えた。
			rerender(
				<ExtensionStateContext.Provider value={{ ...baseState, mode: "custom-mode", customModes: [] } as any}>
					<ModesView />
				</ExtensionStateContext.Provider>,
			)
			fireEvent.click(screen.getByTestId("save-mode-rename-button"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "updateCustomMode" }))
			expect(screen.queryByTestId("save-mode-rename-button")).not.toBeInTheDocument()
		})

		it("defaults a source-less custom mode to global when deleting", () => {
			renderModes({ mode: "custom-mode", customModes: [sourceless] })

			fireEvent.click(screen.getByTestId("delete-mode-button"))
			post({ type: "deleteCustomModeCheck", slug: "custom-mode" })

			expect(screen.getByTestId("delete-mode-confirm")).toBeInTheDocument()
		})

		it("empties the fields of a custom mode", () => {
			renderModes({ mode: "custom-mode", customModes: [sourceless] })

			change(screen.getByTestId("custom-mode-prompt-textarea"), "   ")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ roleDefinition: "", source: "global" }),
				}),
			)

			change(screen.getByTestId("custom-mode-description-textfield"), "  ")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ description: undefined }),
				}),
			)

			change(screen.getByTestId("custom-mode-when-to-use-textarea"), "  ")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ whenToUse: undefined }),
				}),
			)
		})

		it("empties the overrides of a built-in mode", () => {
			renderModes({
				customModePrompts: {
					code: { roleDefinition: "r", description: "d", whenToUse: "w", customInstructions: "c" },
				},
			})

			change(screen.getByTestId("code-description-textfield"), "  ")
			change(screen.getByTestId("code-when-to-use-textarea"), "  ")
			change(screen.getByTestId("code-custom-instructions-textarea"), "  ")

			// 空にした項目は上書きから落ちる（既定へ戻る）。
			const overrides = posted().filter((message) => message.type === "updatePrompt")
			expect(overrides[0].customPrompt).not.toHaveProperty("description")
			expect(overrides[1].customPrompt).not.toHaveProperty("whenToUse")
			expect(overrides[2].customPrompt).not.toHaveProperty("customInstructions")
		})

		it("reads plain events off the element for every field", () => {
			renderModes()
			const plain = (element: Element, value: string) => {
				Object.defineProperty(element, "value", { value, writable: true, configurable: true })
				fireEvent(element, new Event("change", { bubbles: true }))
			}

			plain(screen.getByTestId("code-description-textfield"), "plain description")
			plain(screen.getByTestId("code-when-to-use-textarea"), "plain when")
			plain(screen.getByTestId("code-custom-instructions-textarea"), "plain instructions")
			plain(screen.getByTestId("global-custom-instructions-textarea"), "plain global")

			const overrides = posted().filter((message) => message.type === "updatePrompt")
			expect(overrides).toContainEqual(
				expect.objectContaining({
					customPrompt: expect.objectContaining({ description: "plain description" }),
				}),
			)
			expect(posted()).toContainEqual({ type: "customInstructions", text: "plain global" })
		})

		it("toggles a group on a mode that has none yet", () => {
			renderModes({
				mode: "custom-mode",
				customModes: [{ ...sourceless, groups: undefined } as unknown as ModeConfig],
			})

			fireEvent.click(document.querySelectorAll(".codicon-edit")[1].closest("button")!)
			const checkbox = document.querySelectorAll("vscode-checkbox")[0]
			Object.defineProperty(checkbox, "checked", { value: true, writable: true, configurable: true })
			fireEvent(checkbox, new Event("change", { bubbles: true }))

			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ source: "global" }),
				}),
			)
		})

		it("survives a mode slug it does not know", () => {
			renderModes({ mode: "ghost-mode" })

			expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument()

			const spans = document.querySelectorAll("span.cursor-pointer")
			fireEvent.click(spans[0])
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "openFile" }))
		})

		it("closes the prompt preview from the corner button", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("preview-prompt-button"))
			post({ type: "systemPrompt", text: "prompt body", mode: "code" })

			const closeButton = document.querySelector(".codicon-close")!.closest("button")!
			fireEvent.click(closeButton)

			expect(screen.queryByText("prompt body")).not.toBeInTheDocument()
		})
	})

	describe("last mile", () => {
		const sourceless = { ...customMode, source: undefined } as ModeConfig

		it("swallows clicks inside the config menu", () => {
			renderModes()

			fireEvent.click(configMenuToggle())
			// メニュー自体のクリックは閉じない（外側クリックのハンドラへ伝播させない）。
			fireEvent.click(screen.getByText("prompts:modes.editGlobalModes"))
			fireEvent.click(screen.getByText("prompts:modes.editProjectModes"))

			expect(screen.getByText("prompts:modes.editGlobalModes")).toBeInTheDocument()
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "openCustomModesSettings" }))
		})

		it("does nothing when the active mode is picked again", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.click(screen.getByTestId("mode-option-code"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "mode" }))
		})

		it("defaults a source-less mode to global when renaming", () => {
			renderModes({ mode: "custom-mode", customModes: [sourceless] })

			fireEvent.click(screen.getByTestId("rename-mode-button"))
			input(document.querySelector("vscode-text-field")!, "Renamed")
			fireEvent.click(screen.getByTestId("save-mode-rename-button"))

			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ name: "Renamed", source: "global" }),
				}),
			)
		})

		it("shows the file restriction of the edit group while editing tools", () => {
			const restricted = {
				...customMode,
				groups: ["read", ["edit", { fileRegex: "\\.md$", description: "Markdown only" }]],
			} as unknown as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [restricted] })

			fireEvent.click(document.querySelectorAll(".codicon-edit")[1].closest("button")!)

			expect(screen.getByText(/Markdown only/)).toBeInTheDocument()
		})

		it("falls back to the raw pattern while editing tools", () => {
			const restricted = {
				...customMode,
				groups: ["read", ["edit", { fileRegex: "\\.md$" }]],
			} as unknown as ModeConfig
			renderModes({ mode: "custom-mode", customModes: [restricted] })

			fireEvent.click(document.querySelectorAll(".codicon-edit")[1].closest("button")!)

			expect(screen.getByText(/\.md\$/)).toBeInTheDocument()
		})

		it("treats a missing value as unset", () => {
			const setCustomInstructions = vi.fn()
			renderModes({ mode: "custom-mode", customModes: [sourceless], setCustomInstructions })

			const blank = (element: Element) => {
				Object.defineProperty(element, "value", { value: undefined, writable: true, configurable: true })
				fireEvent(element, new Event("change", { bubbles: true }))
			}

			blank(screen.getByTestId("custom-mode-custom-instructions-textarea"))
			expect(posted()).toContainEqual(
				expect.objectContaining({
					type: "updateCustomMode",
					modeConfig: expect.objectContaining({ customInstructions: undefined, source: "global" }),
				}),
			)

			blank(screen.getByTestId("global-custom-instructions-textarea"))
			expect(setCustomInstructions).toHaveBeenCalledWith(undefined)
			expect(posted()).toContainEqual({ type: "customInstructions", text: undefined })
		})
	})

	describe("api configuration", () => {
		it("loads the profile that was picked", () => {
			renderModes()

			expect(screen.getByTestId("api-config-select")).toHaveAttribute("data-value", "Config 1")

			fireEvent.click(screen.getByTestId("api-config-Config 2"))

			expect(posted()).toContainEqual({ type: "loadApiConfiguration", text: "Config 2" })
		})

		it("tolerates an empty profile list", () => {
			renderModes({ listApiConfigMeta: undefined })

			expect(screen.getByTestId("api-config-select")).toBeInTheDocument()
		})
	})

	describe("system prompt preview", () => {
		it("asks for the prompt and shows it in a dialog", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("preview-prompt-button"))
			expect(posted()).toContainEqual({ type: "getSystemPrompt", mode: "code" })

			post({ type: "systemPrompt", text: "you are a coder", mode: "code" })
			expect(screen.getByText("you are a coder")).toBeInTheDocument()
			expect(screen.getByText("System Prompt (code mode)")).toBeInTheDocument()

			fireEvent.click(screen.getByText("prompts:createModeDialog.close"))
			expect(screen.queryByText("you are a coder")).not.toBeInTheDocument()
		})

		it("ignores an empty prompt message", () => {
			renderModes()

			post({ type: "systemPrompt", mode: "code" })

			expect(screen.queryByText("prompts:createModeDialog.close")).not.toBeInTheDocument()
		})

		it("copies the prompt", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("copy-prompt-button"))

			expect(posted()).toContainEqual({ type: "copySystemPrompt", mode: "code" })
		})
	})
})
