// npx vitest run src/components/settings/__tests__/SettingsView.wiring.spec.tsx

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import SettingsView, { type SettingsViewRef } from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	AlertDialog: ({ children, open, onOpenChange }: any) => (
		<div data-testid="alert-dialog" data-open={String(open)}>
			<button data-testid="alert-dialog-dismiss" onClick={() => onOpenChange(false)} />
			{children}
		</div>
	),
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
	AlertDialogCancel: ({ children, onClick }: any) => (
		<button data-testid="discard-cancel" onClick={onClick}>
			{children}
		</button>
	),
	AlertDialogAction: ({ children, onClick }: any) => (
		<button data-testid="discard-confirm" onClick={onClick}>
			{children}
		</button>
	),
	Button: ({ children, onClick, disabled, variant, className, "data-testid": testId }: any) => (
		<button onClick={onClick} disabled={disabled} data-variant={variant} className={className} data-testid={testId}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div data-tooltip={content}>{children}</div>,
	Tooltip: ({ children }: any) => <div>{children}</div>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
	TooltipProvider: ({ children }: any) => <div>{children}</div>,
	TooltipTrigger: ({ children, onClick }: any) => (
		<div data-testid="compact-tab-trigger" onClick={onClick}>
			{children}
		</div>
	),
}))

vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div>{children}</div>,
	TabHeader: ({ children }: any) => <div>{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(function TabContent({ children, ...rest }, ref) {
		return (
			<div ref={ref} {...rest}>
				{children}
			</div>
		)
	}),
	TabList: ({ children, value, onValueChange, "data-testid": testId, "data-compact": compact }: any) => (
		<div data-testid={testId} data-value={value} data-compact={String(compact)}>
			<button data-testid="tab-list-select-terminal" onClick={() => onValueChange("terminal")} />
			<button data-testid="tab-list-select-about" onClick={() => onValueChange("about")} />
			<button data-testid="tab-list-select-general" onClick={() => onValueChange("general")} />
			<button data-testid="tab-list-select-modes" onClick={() => onValueChange("modes")} />
			{children}
		</div>
	),
	TabTrigger: React.forwardRef<HTMLButtonElement, any>(function TabTrigger(
		{ children, value, isSelected, "data-testid": testId, "data-compact": compact },
		ref,
	) {
		return (
			<button
				ref={ref}
				data-testid={testId}
				data-value={value}
				data-selected={String(isSelected)}
				data-compact={String(compact)}>
				{children}
			</button>
		)
	}),
}))

vi.mock("../ApiConfigManager", () => ({
	__esModule: true,
	default: ({ currentApiConfigName, onSelectConfig, onDeleteConfig, onRenameConfig, onUpsertConfig }: any) => (
		<div data-testid="api-config-manager" data-current={currentApiConfigName}>
			<button data-testid="config-select" onClick={() => onSelectConfig("other")} />
			<button data-testid="config-delete" onClick={() => onDeleteConfig("gone")} />
			<button data-testid="config-rename" onClick={() => onRenameConfig("old", "renamed")} />
			<button data-testid="config-upsert" onClick={() => onUpsertConfig("created")} />
		</div>
	),
}))

vi.mock("../ApiOptions", () => ({
	__esModule: true,
	default: ({ apiConfiguration, setApiConfigurationField, setErrorMessage, uriScheme }: any) => (
		<div data-testid="api-options" data-uri-scheme={uriScheme} data-model={apiConfiguration.apiModelId ?? "none"}>
			<button data-testid="api-set-model" onClick={() => setApiConfigurationField("apiModelId", "gpt-5")} />
			<button
				data-testid="api-set-model-silently"
				onClick={() => setApiConfigurationField("apiModelId", "gpt-5", false)}
			/>
			<button data-testid="api-error" onClick={() => setErrorMessage("settings:invalid")} />
			<button data-testid="api-error-clear" onClick={() => setErrorMessage(undefined)} />
		</div>
	),
}))

vi.mock("../AutoApproveSettings", () => ({
	AutoApproveSettings: ({ setCachedStateField, alwaysAllowMcp }: any) => (
		<div data-testid="auto-approve" data-always-allow-mcp={String(alwaysAllowMcp)}>
			<button data-testid="auto-approve-toggle" onClick={() => setCachedStateField("alwaysAllowMcp", true)} />
		</div>
	),
}))

vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../CheckpointSettings", () => ({ CheckpointSettings: () => <div data-testid="checkpoints" /> }))
vi.mock("../SlashCommandsSettings", () => ({ SlashCommandsSettings: () => <div data-testid="slash-commands" /> }))
vi.mock("../SkillsSettings", () => ({ SkillsSettings: () => <div data-testid="skills" /> }))
vi.mock("@src/components/modes/ModesView", () => ({ __esModule: true, default: () => <div data-testid="modes" /> }))
vi.mock("@src/components/mcp/McpView", () => ({ __esModule: true, default: () => <div data-testid="mcp" /> }))
vi.mock("@src/components/worktrees/WorktreesView", () => ({ WorktreesView: () => <div data-testid="worktrees" /> }))

vi.mock("../ContextManagementSettings", () => ({
	ContextManagementSettings: ({ listApiConfigMeta, maxWorkspaceFiles, customSupportPrompts }: any) => (
		<div
			data-testid="context-management"
			data-config-count={listApiConfigMeta.length}
			data-max-workspace-files={maxWorkspaceFiles}
			data-prompt-keys={Object.keys(customSupportPrompts).join(",")}
		/>
	),
}))

vi.mock("../TerminalSettings", () => ({
	TerminalSettings: ({ setCachedStateField, terminalCommandDelay }: any) => (
		<div data-testid="terminal" data-command-delay={String(terminalCommandDelay)}>
			<div data-setting-id="terminal-delay">delay</div>
			<button data-testid="terminal-change" onClick={() => setCachedStateField("terminalCommandDelay", 25)} />
			<button data-testid="terminal-change-same" onClick={() => setCachedStateField("terminalCommandDelay", 0)} />
		</div>
	),
}))

vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: ({ setExperimentEnabled, experiments }: any) => (
		<div data-testid="experimental" data-enabled={String(experiments?.powerSteering)}>
			<button
				data-testid="experiment-enable"
				onClick={() => setExperimentEnabled("powerSteering" as any, true)}
			/>
			<button
				data-testid="experiment-enable-again"
				onClick={() => setExperimentEnabled("powerSteering" as any, false)}
			/>
		</div>
	),
}))

vi.mock("../LanguageSettings", () => ({
	LanguageSettings: ({ language }: any) => <div data-testid="language" data-language={language} />,
}))

vi.mock("../UISettings", () => ({
	UISettings: ({ reasoningBlockCollapsed, enterBehavior }: any) => (
		<div data-testid="ui" data-collapsed={String(reasoningBlockCollapsed)} data-enter={enterBehavior} />
	),
}))

vi.mock("../About", () => ({
	About: ({ debug, setDebug }: any) => (
		<div data-testid="about" data-debug={String(debug)}>
			<button data-testid="about-debug-on" onClick={() => setDebug(true)} />
			<button data-testid="about-debug-off" onClick={() => setDebug(false)} />
		</div>
	),
}))

vi.mock("../PromptsSettings", () => ({
	__esModule: true,
	default: ({ customSupportPrompts, setCustomSupportPrompts, setIncludeTaskHistoryInEnhance }: any) => (
		<div data-testid="prompts" data-prompt-keys={Object.keys(customSupportPrompts).join(",")}>
			<button data-testid="prompts-set" onClick={() => setCustomSupportPrompts({ ENHANCE: "enhanced prompt" })} />
			<button data-testid="prompts-set-same" onClick={() => setCustomSupportPrompts({})} />
			<button data-testid="prompts-history-off" onClick={() => setIncludeTaskHistoryInEnhance(false)} />
		</div>
	),
}))

vi.mock("../SettingsSearch", () => ({
	SettingsSearch: ({ onNavigate }: any) => (
		<div data-testid="settings-search">
			<button data-testid="search-navigate" onClick={() => onNavigate("terminal", "terminal-delay")} />
			<button data-testid="search-navigate-missing" onClick={() => onNavigate("terminal", "does-not-exist")} />
		</div>
	),
}))

const resizeCallbacks: ResizeObserverCallback[] = []

class CapturingResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeCallbacks.push(callback)
	}
	observe() {}
	unobserve() {}
	disconnect() {}
}

const fullState = () => ({
	currentApiConfigName: "default",
	listApiConfigMeta: [{ id: "1", name: "default", apiProvider: "openai" }],
	uriScheme: "vscode",
	settingsImportedAt: undefined,
	apiConfiguration: { apiProvider: "openai", apiModelId: "gpt-4" },
	language: "ja",
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: true,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: true,
	alwaysAllowWriteProtected: true,
	alwaysAllowExecute: true,
	alwaysAllowMcp: true,
	alwaysAllowSubtasks: true,
	allowedCommands: ["ls"],
	deniedCommands: ["rm"],
	allowedMaxRequests: 20,
	allowedMaxCost: 5,
	autoCondenseContext: true,
	autoCondenseContextPercent: 80,
	enableCheckpoints: true,
	checkpointTimeout: 30,
	writeDelayMs: 100,
	terminalShellIntegrationTimeout: 5000,
	terminalShellIntegrationDisabled: true,
	terminalCommandDelay: 0,
	terminalZdotdir: true,
	terminalOutputPreviewSize: "large",
	mcpEnabled: true,
	maxOpenTabsContext: 30,
	maxWorkspaceFiles: 300,
	showAgentIgnoredFiles: true,
	enableSubfolderRules: true,
	maxImageFileSize: 10,
	maxTotalImageSize: 40,
	includeDiagnosticMessages: false,
	maxDiagnosticMessages: 10,
	alwaysAllowFollowupQuestions: true,
	followupAutoApproveTimeoutMs: 1000,
	includeTaskHistoryInEnhance: false,
	reasoningBlockCollapsed: false,
	enterBehavior: "newline",
	includeCurrentTime: false,
	includeCurrentCost: false,
	maxGitStatusFiles: 50,
	profileThresholds: { default: 70 },
	experiments: { powerSteering: false },
	customSupportPrompts: { ENHANCE: "hi" },
	debug: false,
})

// 値がひとつも設定されていない状態。`??` / `||` のフォールバックが効く側を通す。
const emptyState = () => ({ currentApiConfigName: "default" })

const setState = (state: Record<string, unknown>) => {
	;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue(state)
}

const renderView = (props: { onDone?: () => void; targetSection?: string; ref?: React.Ref<SettingsViewRef> } = {}) => {
	const onDone = props.onDone ?? vi.fn()
	const utils = render(<SettingsView ref={props.ref} onDone={onDone} targetSection={props.targetSection} />)
	return { onDone, ...utils }
}

const lastSettings = () => {
	const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
	const call = [...calls].reverse().find(([message]) => message.type === "updateSettings")
	return call?.[0].updatedSettings
}

describe("SettingsView wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resizeCallbacks.length = 0
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver)
		setState(fullState())
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("starts on the providers tab and indexes every section", () => {
		renderView()

		expect(screen.getByTestId("settings-tab-list")).toHaveAttribute("data-value", "providers")
		expect(screen.getByTestId("api-config-manager")).toHaveAttribute("data-current", "default")
		// 全タブを一巡してインデックスを作り終えたら検索 UI が出る。
		expect(screen.getByTestId("settings-search")).toBeInTheDocument()
	})

	it("starts on the requested section", () => {
		renderView({ targetSection: "terminal" })

		expect(screen.getByTestId("terminal")).toBeInTheDocument()
	})

	it("ignores a section name that does not exist", () => {
		renderView({ targetSection: "not-a-section" })

		expect(screen.getByTestId("api-config-manager")).toBeInTheDocument()
	})

	it("follows the target section when it changes", () => {
		const { rerender } = renderView()

		rerender(<SettingsView onDone={vi.fn()} targetSection="about" />)

		expect(screen.getByTestId("about")).toBeInTheDocument()
	})

	it("switches tabs and remembers the scroll position of the previous tab", () => {
		renderView()

		fireEvent.click(screen.getByTestId("tab-list-select-terminal"))
		expect(screen.getByTestId("terminal")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("tab-list-select-about"))
		expect(screen.getByTestId("about")).toBeInTheDocument()
		expect(screen.queryByTestId("terminal")).not.toBeInTheDocument()
	})

	it("scrolls the active tab into view when the webview becomes visible", () => {
		renderView()
		const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action: "didBecomeVisible" } }))
		})

		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" })

		scrollIntoView.mockClear()
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action: "somethingElse" } }))
		})
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state" } }))
		})
		expect(scrollIntoView).not.toHaveBeenCalled()
	})

	it("switches to compact mode when the container gets narrow", () => {
		renderView()

		expect(screen.getByTestId("settings-tab-list")).toHaveAttribute("data-compact", "false")

		act(() => {
			resizeCallbacks[0]([{ contentRect: { width: 400 } }] as any, {} as any)
		})

		expect(screen.getByTestId("settings-tab-list")).toHaveAttribute("data-compact", "true")

		// コンパクト時はツールチップ側のトリガー経由でタブを切り替える。
		// terminal は sections 配列の 8 番目（0 始まりで index 7）。
		fireEvent.click(screen.getAllByTestId("compact-tab-trigger")[7])
		expect(screen.getByTestId("terminal")).toBeInTheDocument()

		act(() => {
			resizeCallbacks[0]([{ contentRect: { width: 900 } }] as any, {} as any)
		})
		expect(screen.getByTestId("settings-tab-list")).toHaveAttribute("data-compact", "false")
	})

	describe("change detection", () => {
		it("enables saving once a cached field actually changes", () => {
			renderView()
			const save = () => screen.getByTestId("save-button") as HTMLButtonElement

			expect(save().disabled).toBe(true)

			fireEvent.click(screen.getByTestId("tab-list-select-terminal"))
			fireEvent.click(screen.getByTestId("terminal-change-same"))
			expect(save().disabled).toBe(true)

			fireEvent.click(screen.getByTestId("terminal-change"))
			expect(save().disabled).toBe(false)
			expect(screen.getByTestId("terminal")).toHaveAttribute("data-command-delay", "25")
		})

		it("does not mark the initial auto-sync of an empty field as a change", () => {
			setState(emptyState())
			renderView()
			const save = () => screen.getByTestId("save-button") as HTMLButtonElement

			fireEvent.click(screen.getByTestId("api-set-model-silently"))

			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-5")
			expect(save().disabled).toBe(true)

			// 同じ値の再書き込みは状態そのものを触らない。
			fireEvent.click(screen.getByTestId("api-set-model"))
			expect(save().disabled).toBe(true)
		})

		it("marks the api configuration dirty when the value really changes", () => {
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))

			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-5")
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		it("tracks experiment toggles", () => {
			renderView()
			fireEvent.click(screen.getByTestId("tab-list-select-general"))
			const save = () => screen.getByTestId("save-button") as HTMLButtonElement

			fireEvent.click(screen.getByTestId("experiment-enable-again"))
			expect(save().disabled).toBe(true)

			fireEvent.click(screen.getByTestId("experiment-enable"))
			expect(save().disabled).toBe(false)
			expect(screen.getByTestId("experimental")).toHaveAttribute("data-enabled", "true")
		})

		it("tracks the debug switch", () => {
			renderView()
			fireEvent.click(screen.getByTestId("tab-list-select-about"))
			const save = () => screen.getByTestId("save-button") as HTMLButtonElement

			fireEvent.click(screen.getByTestId("about-debug-off"))
			expect(save().disabled).toBe(true)

			fireEvent.click(screen.getByTestId("about-debug-on"))
			expect(save().disabled).toBe(false)
			expect(screen.getByTestId("about")).toHaveAttribute("data-debug", "true")
		})

		it("tracks custom support prompt edits", () => {
			setState({ ...fullState(), customSupportPrompts: {} })
			renderView()
			fireEvent.click(screen.getByTestId("tab-list-select-modes"))
			const save = () => screen.getByTestId("save-button") as HTMLButtonElement

			// 同じ内容の書き戻しは変更として数えない。
			fireEvent.click(screen.getByTestId("prompts-set-same"))
			expect(save().disabled).toBe(true)

			fireEvent.click(screen.getByTestId("prompts-set"))
			expect(save().disabled).toBe(false)
			expect(screen.getByTestId("prompts")).toHaveAttribute("data-prompt-keys", "ENHANCE")
		})

		it("tracks the enhance-with-task-history switch", () => {
			setState({ ...fullState(), includeTaskHistoryInEnhance: true })
			renderView()
			fireEvent.click(screen.getByTestId("tab-list-select-modes"))

			fireEvent.click(screen.getByTestId("prompts-history-off"))
			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastSettings()).toMatchObject({ includeTaskHistoryInEnhance: false })
		})
	})

	describe("saving", () => {
		it("sends the cached settings and the api configuration", () => {
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastSettings()).toMatchObject({
				language: "ja",
				allowedCommands: ["ls"],
				maxOpenTabsContext: 30,
				includeDiagnosticMessages: false,
				includeTaskHistoryInEnhance: false,
				enterBehavior: "newline",
			})
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: { apiProvider: "openai", apiModelId: "gpt-5" },
			})
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "debugSetting", bool: false })
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		it("falls back to the defaults when nothing is configured", () => {
			setState(emptyState())
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastSettings()).toMatchObject({
				allowedCommands: [],
				deniedCommands: [],
				allowedMaxRequests: null,
				allowedMaxCost: null,
				enableCheckpoints: true,
				terminalOutputPreviewSize: "medium",
				includeDiagnosticMessages: true,
				includeTaskHistoryInEnhance: true,
				reasoningBlockCollapsed: true,
				enterBehavior: "send",
				includeCurrentTime: true,
				includeCurrentCost: true,
			})
		})

		it("clamps the workspace limits", () => {
			setState({ ...fullState(), maxOpenTabsContext: 9999, maxWorkspaceFiles: -5 })
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastSettings()).toMatchObject({ maxOpenTabsContext: 500, maxWorkspaceFiles: 0 })
		})

		it("refuses to save while a setting is invalid", () => {
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByTestId("api-error"))

			const save = screen.getByTestId("save-button") as HTMLButtonElement
			expect(save.disabled).toBe(true)
			expect(save.getAttribute("data-variant")).toBe("secondary")

			fireEvent.click(save)
			expect(lastSettings()).toBeUndefined()

			fireEvent.click(screen.getByTestId("api-error-clear"))
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})
	})

	describe("unsaved changes", () => {
		it("leaves immediately when nothing changed", () => {
			const onDone = vi.fn()
			renderView({ onDone })

			fireEvent.click(screen.getByText("settings:common.done"))

			expect(onDone).toHaveBeenCalledTimes(1)
			expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "false")
		})

		it("asks before leaving with unsaved changes and keeps them on cancel", () => {
			const onDone = vi.fn()
			renderView({ onDone })

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByText("settings:common.done"))

			expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "true")
			expect(onDone).not.toHaveBeenCalled()

			fireEvent.click(screen.getByTestId("discard-cancel"))

			expect(onDone).not.toHaveBeenCalled()
			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-5")
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		it("restores the original settings when the changes are discarded", () => {
			const onDone = vi.fn()
			renderView({ onDone })

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByText("settings:common.done"))
			fireEvent.click(screen.getByTestId("discard-confirm"))

			expect(onDone).toHaveBeenCalledTimes(1)
			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-4")
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})

		it("exposes the check to the parent through the ref", () => {
			const ref = React.createRef<SettingsViewRef>()
			renderView({ ref })
			const then = vi.fn()

			act(() => ref.current!.checkUnsaveChanges(then))
			expect(then).toHaveBeenCalledTimes(1)

			fireEvent.click(screen.getByTestId("api-set-model"))
			act(() => ref.current!.checkUnsaveChanges(then))

			expect(then).toHaveBeenCalledTimes(1)
			expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "true")

			fireEvent.click(screen.getByTestId("discard-confirm"))
			expect(then).toHaveBeenCalledTimes(2)
		})

		it("can be dismissed from the dialog itself", () => {
			renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByText("settings:common.done"))
			fireEvent.click(screen.getByTestId("alert-dialog-dismiss"))

			expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "false")
		})
	})

	describe("api configuration profiles", () => {
		it("asks before switching profiles when there are unsaved changes", () => {
			renderView()

			fireEvent.click(screen.getByTestId("config-select"))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "loadApiConfiguration", text: "other" })

			fireEvent.click(screen.getByTestId("api-set-model"))
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()
			fireEvent.click(screen.getByTestId("config-select"))

			expect(vscode.postMessage).not.toHaveBeenCalled()
			expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "true")

			fireEvent.click(screen.getByTestId("discard-confirm"))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "loadApiConfiguration", text: "other" })
		})

		it("deletes, renames and creates profiles", () => {
			renderView()

			fireEvent.click(screen.getByTestId("config-delete"))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteApiConfiguration", text: "gone" })

			fireEvent.click(screen.getByTestId("config-rename"))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "renameApiConfiguration",
				values: { oldName: "old", newName: "renamed" },
				apiConfiguration: { apiProvider: "openai", apiModelId: "gpt-4" },
			})

			fireEvent.click(screen.getByTestId("config-upsert"))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "created",
				apiConfiguration: { apiProvider: "openai", apiModelId: "gpt-4" },
			})
		})

		it("keeps unsaved edits when the rename comes back from the extension", () => {
			const { rerender } = renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			fireEvent.click(screen.getByTestId("config-rename"))

			// 拡張側は改名後の名前で state を返してくる。改名は自分で起こしたものなので
			// 下書きを捨ててはいけない。
			setState({ ...fullState(), currentApiConfigName: "renamed" })
			rerender(<SettingsView onDone={vi.fn()} />)

			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-5")
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)
		})

		it("re-reads the extension state when the profile name changes", () => {
			const { rerender } = renderView()

			fireEvent.click(screen.getByTestId("api-set-model"))
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)

			setState({ ...fullState(), currentApiConfigName: "another" })
			rerender(<SettingsView onDone={vi.fn()} />)

			expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-4")
			expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
		})
	})

	it("busts the cache when settings are imported", () => {
		const { rerender } = renderView()

		fireEvent.click(screen.getByTestId("api-set-model"))
		expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(false)

		setState({ ...fullState(), settingsImportedAt: 123 })
		rerender(<SettingsView onDone={vi.fn()} />)

		expect(screen.getByTestId("api-options")).toHaveAttribute("data-model", "gpt-4")
		expect((screen.getByTestId("save-button") as HTMLButtonElement).disabled).toBe(true)
	})

	describe("search navigation", () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"] })
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("opens the target tab and highlights the setting", () => {
			renderView()

			fireEvent.click(screen.getByTestId("search-navigate"))
			expect(screen.getByTestId("terminal")).toBeInTheDocument()

			const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")
			act(() => {
				vi.advanceTimersByTime(200)
			})

			const target = document.querySelector("[data-setting-id='terminal-delay']")!
			expect(target.classList.contains("settings-highlight")).toBe(true)
			expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })

			act(() => {
				vi.advanceTimersByTime(1500)
			})
			expect(target.classList.contains("settings-highlight")).toBe(false)
		})

		it("does nothing when the setting cannot be found", () => {
			renderView()

			fireEvent.click(screen.getByTestId("search-navigate-missing"))
			act(() => {
				vi.advanceTimersByTime(2000)
			})

			expect(document.querySelectorAll(".settings-highlight")).toHaveLength(0)
		})
	})

	describe("section props", () => {
		it("passes the configured values through", () => {
			renderView()

			fireEvent.click(screen.getByTestId("tab-list-select-terminal"))
			expect(screen.getByTestId("terminal")).toHaveAttribute("data-command-delay", "0")
		})
	})
})
