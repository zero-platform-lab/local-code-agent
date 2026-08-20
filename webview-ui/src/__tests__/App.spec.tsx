// npx vitest run src/__tests__/App.spec.tsx

import React from "react"
import { render, screen, act, cleanup, fireEvent } from "@/utils/test-utils"

import AppWithProviders from "../App"

const mocks = vi.hoisted(() => ({
	postMessage: vi.fn(),
	acceptInput: vi.fn(),
	// ChatView が ref を公開するか（公開しない = マウント直後などで ref が空の状態）
	exposeChatViewHandle: true,
	// SettingsView が checkUnsaveChanges を公開するか
	checkUnsaveChanges: vi.fn(),
	initializeSourceMaps: vi.fn(),
	exposeSourceMapsForDebugging: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: (...args: unknown[]) => mocks.postMessage(...args) },
}))

vi.mock("@src/utils/sourceMapInitializer", () => ({
	initializeSourceMaps: () => mocks.initializeSourceMaps(),
	exposeSourceMapsForDebugging: () => mocks.exposeSourceMapsForDebugging(),
}))

vi.mock("@src/components/chat/ChatView", () => ({
	__esModule: true,
	default: React.forwardRef(function ChatView({ isHidden }: { isHidden: boolean }, ref: React.Ref<unknown>) {
		React.useImperativeHandle(ref, () =>
			mocks.exposeChatViewHandle ? { acceptInput: mocks.acceptInput, focusInput: vi.fn() } : null,
		)
		return (
			<div data-testid="chat-view" data-hidden={isHidden}>
				Chat View
			</div>
		)
	}),
}))

vi.mock("@src/components/settings/SettingsView", () => ({
	__esModule: true,
	default: React.forwardRef(function SettingsView(
		{ onDone, targetSection }: { onDone: () => void; targetSection?: string },
		ref: React.Ref<unknown>,
	) {
		React.useImperativeHandle(ref, () => ({ checkUnsaveChanges: mocks.checkUnsaveChanges }))
		return (
			<div data-testid="settings-view" data-section={targetSection ?? "none"} onClick={onDone}>
				Settings View
			</div>
		)
	}),
}))

vi.mock("@src/components/history/HistoryView", () => ({
	__esModule: true,
	default: function HistoryView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="history-view" onClick={onDone}>
				History View
			</div>
		)
	},
}))

type DialogProps = {
	open: boolean
	type?: string
	hasCheckpoint?: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: (restoreCheckpoint?: boolean) => void
}

const renderDialogHarness = (testId: string, { open, onOpenChange, onConfirm }: DialogProps) => (
	<div data-testid={testId} data-open={open}>
		<button data-testid={`${testId}-close`} onClick={() => onOpenChange(false)} />
		<button data-testid={`${testId}-reopen`} onClick={() => onOpenChange(true)} />
		<button data-testid={`${testId}-confirm`} onClick={() => onConfirm(true)} />
		<button data-testid={`${testId}-confirm-without-restore`} onClick={() => onConfirm(false)} />
	</div>
)

vi.mock("@src/components/chat/CheckpointRestoreDialog", () => ({
	CheckpointRestoreDialog: (props: DialogProps) => renderDialogHarness(`checkpoint-${props.type}-dialog`, props),
	EditMessageWithCheckpointDialog: () => null,
	DeleteMessageWithCheckpointDialog: () => null,
}))

vi.mock("@src/components/chat/MessageModificationConfirmationDialog", () => ({
	MessageModificationConfirmationDialog: () => null,
	DeleteMessageDialog: (props: DialogProps) => renderDialogHarness("delete-message-dialog", props),
	EditMessageDialog: (props: DialogProps) => renderDialogHarness("edit-message-dialog", props),
}))

const mockUseExtensionState = vi.fn()

// Mock i18next and react-i18next
vi.mock("i18next", () => {
	const tFunction = (key: string) => key
	const i18n = {
		t: tFunction,
		use: () => i18n,
		init: () => Promise.resolve(tFunction),
		changeLanguage: vi.fn(() => Promise.resolve()),
	}
	return { default: i18n }
})

vi.mock("react-i18next", () => {
	const tFunction = (key: string) => key
	return {
		withTranslation: () => (Component: any) => {
			const MockedComponent = (props: any) => {
				return <Component t={tFunction} i18n={{ t: tFunction }} tReady {...props} />
			}
			MockedComponent.displayName = `withTranslation(${Component.displayName || Component.name || "Component"})`
			return MockedComponent
		},
		Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useTranslation: () => {
			return {
				t: tFunction,
				i18n: {
					t: tFunction,
					changeLanguage: vi.fn(() => Promise.resolve()),
				},
			}
		},
		initReactI18next: {
			type: "3rdParty",
			init: vi.fn(),
		},
	}
})

// Mock TranslationProvider to pass through children
vi.mock("@src/i18n/TranslationContext", () => {
	const tFunction = (key: string) => key
	return {
		__esModule: true,
		default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useAppTranslation: () => ({
			t: tFunction,
			i18n: {
				t: tFunction,
				changeLanguage: vi.fn(() => Promise.resolve()),
			},
		}),
	}
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
	ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("App", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.exposeChatViewHandle = true

		// Set up default mock return value
		mockUseExtensionState.mockReturnValue({
			didHydrateState: true,
			experiments: {},
			language: "en",
			renderContext: "sidebar",
		})
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllEnvs()
	})

	const postExtensionMessage = (data: Record<string, unknown>) => {
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data }))
		})
	}

	const triggerMessage = (action: string) => postExtensionMessage({ type: "action", action })

	it("shows chat view by default", () => {
		render(<AppWithProviders />)

		const chatView = screen.getByTestId("chat-view")
		expect(chatView).toBeInTheDocument()
		expect(chatView.getAttribute("data-hidden")).toBe("false")
	}, 10000)

	it("renders nothing until the extension state is hydrated", () => {
		mockUseExtensionState.mockReturnValue({ didHydrateState: false, renderContext: "sidebar" })

		render(<AppWithProviders />)

		expect(screen.queryByTestId("chat-view")).not.toBeInTheDocument()
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("tells the extension that the webview launched", () => {
		render(<AppWithProviders />)

		expect(mocks.postMessage).toHaveBeenCalledWith({ type: "webviewDidLaunch" })
	})

	it("switches to settings view when receiving settingsButtonClicked action", async () => {
		render(<AppWithProviders />)

		triggerMessage("settingsButtonClicked")

		const settingsView = await screen.findByTestId("settings-view")
		expect(settingsView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it("switches to history view when receiving historyButtonClicked action", async () => {
		render(<AppWithProviders />)

		triggerMessage("historyButtonClicked")

		const historyView = await screen.findByTestId("history-view")
		expect(historyView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it("returns to chat view when clicking done in settings view", async () => {
		render(<AppWithProviders />)

		triggerMessage("settingsButtonClicked")

		const settingsView = await screen.findByTestId("settings-view")

		act(() => {
			settingsView.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it.each(["history"])("returns to chat view when clicking done in %s view", async (view) => {
		render(<AppWithProviders />)

		triggerMessage(`${view}ButtonClicked`)

		const viewElement = await screen.findByTestId(`${view}-view`)

		act(() => {
			viewElement.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId(`${view}-view`)).not.toBeInTheDocument()
	})

	it("switches back to chat when receiving chatButtonClicked action", async () => {
		render(<AppWithProviders />)

		triggerMessage("historyButtonClicked")
		expect(await screen.findByTestId("history-view")).toBeInTheDocument()

		triggerMessage("chatButtonClicked")

		expect(screen.queryByTestId("history-view")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-view").getAttribute("data-hidden")).toBe("false")
	})

	it("ignores actions that are not mapped to a tab", () => {
		render(<AppWithProviders />)

		triggerMessage("mcpButtonClicked")

		expect(screen.getByTestId("chat-view").getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("ignores action messages without an action", () => {
		render(<AppWithProviders />)

		postExtensionMessage({ type: "action" })

		expect(screen.getByTestId("chat-view").getAttribute("data-hidden")).toBe("false")
	})

	it("ignores unrelated message types", () => {
		render(<AppWithProviders />)

		postExtensionMessage({ type: "state" })

		expect(screen.getByTestId("chat-view").getAttribute("data-hidden")).toBe("false")
		expect(screen.getByTestId("delete-message-dialog").getAttribute("data-open")).toBe("false")
		expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("false")
	})

	describe("switchTab action", () => {
		it("switches to the requested tab and forwards the target section", async () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "action", action: "switchTab", tab: "settings", values: { section: "about" } })

			const settingsView = await screen.findByTestId("settings-view")
			expect(settingsView.getAttribute("data-section")).toBe("about")
		})

		it("clears the target section when none is provided", async () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "action", action: "switchTab", tab: "settings" })

			const settingsView = await screen.findByTestId("settings-view")
			expect(settingsView.getAttribute("data-section")).toBe("none")
		})

		it("does nothing when the tab is missing", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "action", action: "switchTab" })

			expect(screen.getByTestId("chat-view").getAttribute("data-hidden")).toBe("false")
			expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
		})
	})

	describe("unsaved settings changes", () => {
		it("defers the tab switch to SettingsView while it is mounted", async () => {
			render(<AppWithProviders />)

			triggerMessage("settingsButtonClicked")
			await screen.findByTestId("settings-view")

			triggerMessage("historyButtonClicked")

			// SettingsView が確認を挟むまでタブは切り替わらない。
			expect(screen.getByTestId("settings-view")).toBeInTheDocument()
			expect(screen.queryByTestId("history-view")).not.toBeInTheDocument()
			expect(mocks.checkUnsaveChanges).toHaveBeenCalledTimes(1)

			act(() => {
				mocks.checkUnsaveChanges.mock.calls[0][0]()
			})

			expect(await screen.findByTestId("history-view")).toBeInTheDocument()
			expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
		})

		it("forwards the section of the pending tab once the switch is confirmed", async () => {
			render(<AppWithProviders />)

			triggerMessage("settingsButtonClicked")
			await screen.findByTestId("settings-view")

			postExtensionMessage({
				type: "action",
				action: "settingsButtonClicked",
				values: { section: "providers" },
			})

			act(() => {
				mocks.checkUnsaveChanges.mock.calls[0][0]()
			})

			expect(screen.getByTestId("settings-view").getAttribute("data-section")).toBe("providers")
		})
	})

	describe("acceptInput", () => {
		it("forwards acceptInput to the chat view", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "acceptInput" })

			expect(mocks.acceptInput).toHaveBeenCalledTimes(1)
		})

		it("does nothing when the chat view has no handle yet", () => {
			mocks.exposeChatViewHandle = false
			render(<AppWithProviders />)

			postExtensionMessage({ type: "acceptInput" })

			expect(mocks.acceptInput).not.toHaveBeenCalled()
		})
	})

	describe("delete message dialog", () => {
		it("ignores the request when the timestamp is missing", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog" })

			expect(screen.getByTestId("delete-message-dialog").getAttribute("data-open")).toBe("false")
		})

		it("opens the plain dialog and confirms the deletion", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog", messageTs: 1234 })

			const dialog = screen.getByTestId("delete-message-dialog")
			expect(dialog.getAttribute("data-open")).toBe("true")
			expect(screen.queryByTestId("checkpoint-delete-dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByTestId("delete-message-dialog-confirm"))

			expect(mocks.postMessage).toHaveBeenCalledWith({ type: "deleteMessageConfirm", messageTs: 1234 })
			expect(screen.getByTestId("delete-message-dialog").getAttribute("data-open")).toBe("false")
		})

		it("closes the plain dialog without deleting anything", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog", messageTs: 1234 })
			fireEvent.click(screen.getByTestId("delete-message-dialog-close"))

			expect(screen.getByTestId("delete-message-dialog").getAttribute("data-open")).toBe("false")
			expect(mocks.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "deleteMessageConfirm" }),
			)
		})

		it("opens the checkpoint dialog and forwards the restore choice", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog", messageTs: 42, hasCheckpoint: true })

			const dialog = screen.getByTestId("checkpoint-delete-dialog")
			expect(dialog.getAttribute("data-open")).toBe("true")
			expect(screen.queryByTestId("delete-message-dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByTestId("checkpoint-delete-dialog-confirm-without-restore"))

			expect(mocks.postMessage).toHaveBeenCalledWith({
				type: "deleteMessageConfirm",
				messageTs: 42,
				restoreCheckpoint: false,
			})
			expect(screen.getByTestId("checkpoint-delete-dialog").getAttribute("data-open")).toBe("false")
		})

		it("restores the checkpoint when the user asks for it", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog", messageTs: 42, hasCheckpoint: true })
			fireEvent.click(screen.getByTestId("checkpoint-delete-dialog-confirm"))

			expect(mocks.postMessage).toHaveBeenCalledWith({
				type: "deleteMessageConfirm",
				messageTs: 42,
				restoreCheckpoint: true,
			})
		})

		it("closes the checkpoint dialog without deleting anything", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showDeleteMessageDialog", messageTs: 42, hasCheckpoint: true })
			fireEvent.click(screen.getByTestId("checkpoint-delete-dialog-close"))

			expect(screen.getByTestId("checkpoint-delete-dialog").getAttribute("data-open")).toBe("false")
			expect(mocks.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "deleteMessageConfirm" }),
			)
		})

		it("reopens the dialog when the dialog asks for it", () => {
			render(<AppWithProviders />)

			fireEvent.click(screen.getByTestId("delete-message-dialog-reopen"))

			expect(screen.getByTestId("delete-message-dialog").getAttribute("data-open")).toBe("true")
		})
	})

	describe("edit message dialog", () => {
		it("ignores the request when the text is missing", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showEditMessageDialog", messageTs: 1234 })

			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("false")
		})

		it("ignores the request when the timestamp is missing", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showEditMessageDialog", text: "hello" })

			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("false")
		})

		it("opens the plain dialog and confirms the edit with the images it was given", () => {
			render(<AppWithProviders />)

			postExtensionMessage({
				type: "showEditMessageDialog",
				messageTs: 7,
				text: "edited",
				images: ["data:image/png;base64,AAA"],
			})

			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("true")

			fireEvent.click(screen.getByTestId("edit-message-dialog-confirm"))

			expect(mocks.postMessage).toHaveBeenCalledWith({
				type: "editMessageConfirm",
				messageTs: 7,
				text: "edited",
				images: ["data:image/png;base64,AAA"],
			})
			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("false")
		})

		it("confirms with an empty image list when no images were provided", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showEditMessageDialog", messageTs: 7, text: "edited" })
			fireEvent.click(screen.getByTestId("edit-message-dialog-confirm"))

			expect(mocks.postMessage).toHaveBeenCalledWith({
				type: "editMessageConfirm",
				messageTs: 7,
				text: "edited",
				images: [],
			})
		})

		it("closes the plain dialog without editing anything", () => {
			render(<AppWithProviders />)

			postExtensionMessage({ type: "showEditMessageDialog", messageTs: 7, text: "edited" })
			fireEvent.click(screen.getByTestId("edit-message-dialog-close"))

			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("false")
			expect(mocks.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editMessageConfirm" }))
		})

		it("opens the checkpoint dialog and forwards the restore choice", () => {
			render(<AppWithProviders />)

			postExtensionMessage({
				type: "showEditMessageDialog",
				messageTs: 9,
				text: "edited",
				hasCheckpoint: true,
			})

			expect(screen.getByTestId("checkpoint-edit-dialog").getAttribute("data-open")).toBe("true")
			expect(screen.queryByTestId("edit-message-dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByTestId("checkpoint-edit-dialog-confirm"))

			expect(mocks.postMessage).toHaveBeenCalledWith({
				type: "editMessageConfirm",
				messageTs: 9,
				text: "edited",
				restoreCheckpoint: true,
			})
			expect(screen.getByTestId("checkpoint-edit-dialog").getAttribute("data-open")).toBe("false")
		})

		it("closes the checkpoint dialog without editing anything", () => {
			render(<AppWithProviders />)

			postExtensionMessage({
				type: "showEditMessageDialog",
				messageTs: 9,
				text: "edited",
				hasCheckpoint: true,
			})
			fireEvent.click(screen.getByTestId("checkpoint-edit-dialog-close"))

			expect(screen.getByTestId("checkpoint-edit-dialog").getAttribute("data-open")).toBe("false")
			expect(mocks.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editMessageConfirm" }))
		})

		it("reopens the dialog when the dialog asks for it", () => {
			render(<AppWithProviders />)

			fireEvent.click(screen.getByTestId("edit-message-dialog-reopen"))

			expect(screen.getByTestId("edit-message-dialog").getAttribute("data-open")).toBe("true")
		})
	})

	describe("source maps", () => {
		it("initializes source map support", () => {
			render(<AppWithProviders />)

			expect(mocks.initializeSourceMaps).toHaveBeenCalledTimes(1)
			expect(mocks.exposeSourceMapsForDebugging).not.toHaveBeenCalled()
		})

		it("exposes the debugging helpers in production builds", () => {
			vi.stubEnv("NODE_ENV", "production")

			render(<AppWithProviders />)

			expect(mocks.exposeSourceMapsForDebugging).toHaveBeenCalledTimes(1)
		})
	})

	describe("non-interactive click handling", () => {
		it("asks the extension to focus the panel in editor mode", () => {
			mockUseExtensionState.mockReturnValue({ didHydrateState: true, renderContext: "editor" })
			render(<AppWithProviders />)

			fireEvent.click(document.body)

			expect(mocks.postMessage).toHaveBeenCalledWith({ type: "focusPanelRequest" })
		})

		it("does not ask for focus in the sidebar", () => {
			render(<AppWithProviders />)

			fireEvent.click(document.body)

			expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "focusPanelRequest" })
		})
	})
})
