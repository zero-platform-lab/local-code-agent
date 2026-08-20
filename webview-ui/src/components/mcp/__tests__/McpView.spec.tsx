// npx vitest src/components/mcp/__tests__/McpView.spec.tsx

import React from "react"
import { render, screen, fireEvent, within } from "@/utils/test-utils"

import type { McpServer } from "@openai-agent/types"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import McpView from "../McpView"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Trans は子をそのまま描画する軽量スタブに。
vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// isOverThreshold を制御するために hook をモック。
const toolsInfo = vi.hoisted(() => ({ isOverThreshold: false }))
vi.mock("@src/hooks/useTooManyTools", () => ({
	useTooManyTools: () => ({
		isOverThreshold: toolsInfo.isOverThreshold,
		title: "too-many-title",
		message: "too-many-message",
		enabledServerCount: 0,
		enabledToolCount: 0,
		threshold: 60,
	}),
}))

// FAST の web component をプレーン要素に差し替える。
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, ...props }: { children?: React.ReactNode }) => <a {...props}>{children}</a>,
	VSCodePanels: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	VSCodePanelTab: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	VSCodePanelView: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	VSCodeCheckbox: ({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))

const makeServer = (overrides: Partial<McpServer> = {}): McpServer => ({
	name: "srv",
	config: "{}",
	status: "connected",
	...overrides,
})

const renderView = (servers: McpServer[], extra: { mcpEnabled?: boolean; alwaysAllowMcp?: boolean } = {}) => {
	const value = {
		mcpServers: servers,
		alwaysAllowMcp: extra.alwaysAllowMcp ?? true,
		mcpEnabled: extra.mcpEnabled ?? true,
		setMcpEnabled: vi.fn(),
	}
	return render(
		<ExtensionStateContext.Provider value={value as never}>
			<McpView />
		</ExtensionStateContext.Provider>,
	)
}

// server 名から行内アイコンボタンを引く小道具。
const iconButton = (container: HTMLElement, iconClass: string) =>
	container.querySelector(`.${iconClass}`)?.closest("button") as HTMLButtonElement

beforeEach(() => {
	vi.clearAllMocks()
	toolsInfo.isOverThreshold = false
})

describe("McpView outer", () => {
	it("hides the server section and edit buttons when mcp is disabled", () => {
		renderView([makeServer()], { mcpEnabled: false })
		expect(screen.getByText("mcp:title")).toBeInTheDocument()
		expect(screen.queryByText("mcp:editGlobalMCP")).not.toBeInTheDocument()
		expect(screen.queryByText("srv")).not.toBeInTheDocument()
	})

	it("shows edit buttons when enabled and wires their messages", () => {
		renderView([])
		fireEvent.click(screen.getByText("mcp:editGlobalMCP"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openMcpSettings" })

		fireEvent.click(screen.getByText("mcp:editProjectMCP"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openProjectMcpSettings" })

		fireEvent.click(screen.getByText("mcp:refreshMCP"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "refreshAllMcpServers" })
	})

	it("does not render the server list when there are no servers", () => {
		renderView([])
		expect(screen.queryByText("srv")).not.toBeInTheDocument()
	})

	it("hides the too-many-tools warning below threshold", () => {
		renderView([])
		expect(screen.queryByText("too-many-title")).not.toBeInTheDocument()
	})

	it("shows the too-many-tools warning over threshold", () => {
		toolsInfo.isOverThreshold = true
		renderView([])
		expect(screen.getByText("too-many-title")).toBeInTheDocument()
		expect(screen.getByText("too-many-message")).toBeInTheDocument()
	})
})

describe("ServerRow status and expandability", () => {
	it("expands a connected+enabled server and collapses again", () => {
		const { container } = renderView([makeServer({ name: "conn", status: "connected", source: "global" })])
		// 展開前はタイムアウト UI が無い
		expect(container.querySelector("select")).toBeNull()
		fireEvent.click(screen.getByText("conn"))
		expect(container.querySelector("select")).not.toBeNull()
		// もう一度クリックで畳む
		fireEvent.click(screen.getByText("conn"))
		expect(container.querySelector("select")).toBeNull()
	})

	it("renders a disabled server as non-expandable and neither panels nor error", () => {
		const { container } = renderView([
			makeServer({ name: "off", status: "connected", disabled: true, source: "global" }),
		])
		fireEvent.click(screen.getByText("off"))
		// 展開しない
		expect(container.querySelector("select")).toBeNull()
		// エラー UI も出ない
		expect(screen.queryByText("mcp:serverStatus.retryConnection")).not.toBeInTheDocument()
		// トグルは再有効化を送る
		const toggle = screen.getByRole("switch", { name: "Toggle off server" })
		fireEvent.click(toggle)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "toggleMcpServer",
			serverName: "off",
			source: "global",
			disabled: false,
		})
	})

	it("shows retrying UI with a disabled restart for a connecting server", () => {
		const { container } = renderView([makeServer({ name: "cx", status: "connecting" })])
		expect(screen.getByText("mcp:serverStatus.retrying")).toBeInTheDocument()
		// ヘッダの restart は connecting のとき無効
		const headerRestart = iconButton(container, "codicon-refresh")
		expect(headerRestart).toBeDisabled()
		// toggle は source 無し → "global" 既定
		fireEvent.click(screen.getByRole("switch", { name: "Toggle cx server" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "toggleMcpServer",
			serverName: "cx",
			source: "global",
			disabled: true,
		})
	})

	it("shows a multi-line error and an enabled retry for a disconnected server", () => {
		const { container } = renderView([
			makeServer({
				name: "dc",
				status: "disconnected",
				source: "global",
				error: "line1\nline2\nline3",
			}),
		])
		expect(screen.getByText(/line1/)).toBeInTheDocument()
		expect(screen.getByText(/line3/)).toBeInTheDocument()

		const retry = screen.getByText("mcp:serverStatus.retryConnection")
		fireEvent.click(retry)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "restartMcpServer",
			text: "dc",
			source: "global",
		})
		// ヘッダの restart（source 無しでない → global）も有効
		expect(iconButton(container, "codicon-refresh")).not.toBeDisabled()
	})

	it("renders error UI even when a disconnected server has no error text", () => {
		renderView([makeServer({ name: "dcn", status: "disconnected" })])
		// error 無し → エラー文字列は出ないが retry ボタンは出る
		expect(screen.getByText("mcp:serverStatus.retryConnection")).toBeInTheDocument()
	})
})

describe("ServerRow expanded panels", () => {
	const fullServer = makeServer({
		name: "full",
		status: "connected",
		source: "global",
		config: JSON.stringify({ timeout: 30 }),
		tools: [
			{ name: "toolA", description: "A", enabledForPrompt: true },
			{ name: "toolB", description: "B", enabledForPrompt: true },
		],
		resources: [{ uri: "res://one", name: "R1", mimeType: "text/plain" }],
		resourceTemplates: [{ uriTemplate: "res://{t}", name: "T1" }],
		instructions: "server instructions here",
		errorHistory: [
			{ message: "older", level: "warn", timestamp: 1000 },
			{ message: "newer", level: "error", timestamp: 2000 },
		],
	})

	it("renders tools, resources, instructions and sorted logs", () => {
		renderView([fullServer])
		fireEvent.click(screen.getByText("full"))

		// tools
		expect(screen.getByText("toolA")).toBeInTheDocument()
		expect(screen.getByText("toolB")).toBeInTheDocument()
		// resources (template + resource)
		expect(screen.getByText("res://one")).toBeInTheDocument()
		expect(screen.getByText("res://{t}")).toBeInTheDocument()
		// instructions
		expect(screen.getByText("server instructions here")).toBeInTheDocument()
		// logs
		expect(screen.getByText("older")).toBeInTheDocument()
		expect(screen.getByText("newer")).toBeInTheDocument()
		// source badge
		expect(screen.getByText("global")).toBeInTheDocument()
	})

	it("changes the network timeout for a server with a source", () => {
		const { container } = renderView([fullServer])
		fireEvent.click(screen.getByText("full"))
		const select = container.querySelector("select") as HTMLSelectElement
		// config の timeout=30 が初期値
		expect(select.value).toBe("30")
		fireEvent.change(select, { target: { value: "300" } })
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateMcpTimeout",
			serverName: "full",
			source: "global",
			timeout: 300,
		})
	})

	it("shows empty states and default timeout for an empty server", () => {
		const { container } = renderView([
			makeServer({ name: "empty", status: "connected", source: "project", config: "null" }),
		])
		fireEvent.click(screen.getByText("empty"))

		expect(screen.getByText("mcp:emptyState.noTools")).toBeInTheDocument()
		expect(screen.getByText("mcp:emptyState.noResources")).toBeInTheDocument()
		expect(screen.getByText("mcp:emptyState.noLogs")).toBeInTheDocument()
		// instructions タブは無い
		expect(screen.queryByText("mcp:instructions")).not.toBeInTheDocument()
		// config が "null" → タイムアウト既定 60
		const select = container.querySelector("select") as HTMLSelectElement
		expect(select.value).toBe("60")
	})

	// resources のみ（templates 無し）: `server.resourceTemplates || []` の既定側を踏む。
	it("renders a server that has resources but no templates", () => {
		renderView([
			makeServer({
				name: "resonly",
				status: "connected",
				source: "global",
				resources: [{ uri: "res://only", name: "RO" }],
			}),
		])
		fireEvent.click(screen.getByText("resonly"))
		expect(screen.getByText("res://only")).toBeInTheDocument()
	})

	// templates のみ（resources 無し）: 条件の右辺 `resourceTemplates && length>0` と
	// `server.resources || []` の既定側を踏む。
	it("renders a server that has templates but no resources", () => {
		renderView([
			makeServer({
				name: "tplonly",
				status: "connected",
				source: "global",
				// resources はあえて未定義にして `server.resources || []` の既定側を踏む
				resourceTemplates: [{ uriTemplate: "tpl://only", name: "TO" }],
			}),
		])
		fireEvent.click(screen.getByText("tplonly"))
		expect(screen.getByText("tpl://only")).toBeInTheDocument()
	})

	it("passes global source and hides badge for a source-less server, timeout change uses global", () => {
		const { container } = renderView([
			makeServer({
				name: "nosrc",
				status: "connected",
				config: "{}",
				tools: [{ name: "toolC", description: "C", enabledForPrompt: true }],
			}),
		])
		fireEvent.click(screen.getByText("nosrc"))
		// tool は描画される（serverSource は "global" 既定）
		expect(screen.getByText("toolC")).toBeInTheDocument()
		// config {} → 60 既定
		const select = container.querySelector("select") as HTMLSelectElement
		expect(select.value).toBe("60")
		fireEvent.change(select, { target: { value: "15" } })
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateMcpTimeout",
			serverName: "nosrc",
			source: "global",
			timeout: 15,
		})
	})
})

describe("ServerRow header actions and delete flow", () => {
	it("restarts via the header button using the default global source", () => {
		const { container } = renderView([makeServer({ name: "hdr", status: "connected" })])
		// connected（connecting でない）なのでヘッダ restart は有効
		const headerRestart = iconButton(container, "codicon-refresh")
		expect(headerRestart).not.toBeDisabled()
		fireEvent.click(headerRestart)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "restartMcpServer",
			text: "hdr",
			source: "global",
		})
	})

	it("toggles a server with a source off", () => {
		renderView([makeServer({ name: "ts", status: "connected", source: "project" })])
		fireEvent.click(screen.getByRole("switch", { name: "Toggle ts server" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "toggleMcpServer",
			serverName: "ts",
			source: "project",
			disabled: true,
		})
	})

	it("cancels the delete confirmation without sending a message", () => {
		const { container } = renderView([makeServer({ name: "d1", status: "connected", source: "global" })])
		fireEvent.click(iconButton(container, "codicon-trash"))
		const dialog = screen.getByText("mcp:deleteDialog.title").closest("div") as HTMLElement
		fireEvent.click(within(dialog.parentElement as HTMLElement).getByText("mcp:deleteDialog.cancel"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteMcpServer" }))
	})

	it("confirms delete for a server with a source", () => {
		const { container } = renderView([makeServer({ name: "d2", status: "connected", source: "global" })])
		fireEvent.click(iconButton(container, "codicon-trash"))
		fireEvent.click(screen.getByText("mcp:deleteDialog.delete"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "deleteMcpServer",
			serverName: "d2",
			source: "global",
		})
	})

	it("confirms delete for a source-less server using the global default", () => {
		const { container } = renderView([makeServer({ name: "d3", status: "connecting" })])
		fireEvent.click(iconButton(container, "codicon-trash"))
		fireEvent.click(screen.getByText("mcp:deleteDialog.delete"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "deleteMcpServer",
			serverName: "d3",
			source: "global",
		})
	})
})
