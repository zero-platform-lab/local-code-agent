// npx vitest run src/components/modes/__tests__/ModesView.wiring.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

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

const baseState = {
	customModePrompts: {},
	listApiConfigMeta: [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	],
	mode: "code",
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

const change = (element: Element, value: string) => {
	fireEvent(element, new CustomEvent("change", { detail: { target: { value } } }))
}

describe("ModesView wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("mode fields", () => {
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

		it("edits the research mode when it is active", () => {
			renderModes({ mode: "research" })

			change(screen.getByTestId("research-prompt-textarea"), "investigate")

			expect(posted()).toContainEqual({
				type: "updatePrompt",
				promptMode: "research",
				customPrompt: { roleDefinition: "investigate" },
			})
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

		it("clears the other field overrides the same way", () => {
			// description / whenToUse / customInstructions も空にすると上書きが解除される。
			// ペイロードの整形（キーの除去）は modePromptOverrides.spec が検証する。
			renderModes({ customModePrompts: { code: { description: "stored" } } })

			change(screen.getByTestId("code-description-textfield"), "   ")
			change(screen.getByTestId("code-when-to-use-textarea"), "   ")
			change(screen.getByTestId("code-custom-instructions-textarea"), "   ")

			expect(posted().filter((message) => message.type === "updatePrompt")).toHaveLength(3)
		})

		it("reads a value straight off the event target when there is no detail", () => {
			renderModes()

			const direct = (element: Element, value: string) => {
				Object.defineProperty(element, "value", { value, writable: true, configurable: true })
				fireEvent(element, new Event("change", { bubbles: true }))
			}

			direct(screen.getByTestId("code-prompt-textarea"), "typed directly")
			expect(posted()).toContainEqual({
				type: "updatePrompt",
				promptMode: "code",
				customPrompt: { roleDefinition: "typed directly" },
			})

			direct(screen.getByTestId("code-description-textfield"), "typed description")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					customPrompt: expect.objectContaining({ description: "typed description" }),
				}),
			)

			direct(screen.getByTestId("code-when-to-use-textarea"), "typed when")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					customPrompt: expect.objectContaining({ whenToUse: "typed when" }),
				}),
			)

			direct(screen.getByTestId("code-custom-instructions-textarea"), "typed rules")
			expect(posted()).toContainEqual(
				expect.objectContaining({
					customPrompt: expect.objectContaining({ customInstructions: "typed rules" }),
				}),
			)
		})

		it("offers a reset for every field", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("role-definition-reset"))
			fireEvent.click(screen.getByTestId("description-reset"))
			fireEvent.click(screen.getByTestId("when-to-use-reset"))
			fireEvent.click(screen.getByTestId("custom-instructions-reset"))

			expect(posted().filter((message) => message.type === "updatePrompt")).toHaveLength(4)
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

		it("treats a missing value as unset", () => {
			const setCustomInstructions = vi.fn()
			renderModes({ setCustomInstructions })

			const blank = (element: Element) => {
				Object.defineProperty(element, "value", { value: undefined, writable: true, configurable: true })
				fireEvent(element, new Event("change", { bubbles: true }))
			}

			blank(screen.getByTestId("global-custom-instructions-textarea"))
			expect(setCustomInstructions).toHaveBeenCalledWith(undefined)
			expect(posted()).toContainEqual({ type: "customInstructions", text: undefined })
		})
	})

	describe("tools", () => {
		it("explains that the groups are fixed and lists them", () => {
			renderModes()

			expect(screen.getByText("prompts:tools.builtInModesText")).toBeInTheDocument()
			// code は read / edit / command / mcp の 4 グループを持つ。
			expect(
				screen.getByText(
					[
						"prompts:tools.toolNames.read",
						"prompts:tools.toolNames.edit",
						"prompts:tools.toolNames.command",
						"prompts:tools.toolNames.mcp",
					].join(", "),
				),
			).toBeInTheDocument()
		})
	})

	describe("mode picker", () => {
		it("switches to the picked mode", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.click(screen.getByTestId("mode-option-research"))

			expect(posted()).toContainEqual({ type: "mode", text: "research" })
		})

		it("does nothing when the active mode is picked again", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.click(screen.getByTestId("mode-option-code"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "mode" }))
		})

		it("clears the search box from the clear button", () => {
			renderModes()

			fireEvent.click(screen.getByTestId("mode-select-trigger"))
			fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "res" } })
			expect(screen.getByTestId("mode-search-input")).toHaveValue("res")

			// クリアは検索欄の右端に出る X アイコン。
			fireEvent.click(document.querySelector("svg.cursor-pointer")!)

			expect(screen.getByTestId("mode-search-input")).toHaveValue("")
		})

		it("forgets the search shortly after closing", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderModes()

				fireEvent.click(screen.getByTestId("mode-select-trigger"))
				fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "res" } })
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
