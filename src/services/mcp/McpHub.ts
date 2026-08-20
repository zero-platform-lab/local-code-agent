import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import delay from "delay"

import type { McpResourceResponse, McpServer, McpToolCallResponse } from "@openai-agent/types"

import { t } from "../../i18n"

import type { McpProviderRef } from "./mcpProviderRef"
import { DisableReason } from "./mcpConnection"
import { McpConnectionStore } from "./McpConnectionStore"
import { McpServerFileWatchers } from "./McpServerFileWatchers"
import { McpConfigWatcher } from "./McpConfigWatcher"
import {
	createConnectedConnection,
	createPlaceholderConnection,
	makeConnectionTransportHandlers,
	recordConnectionFailure,
	resolveConnectPlan,
} from "./connectServer"
import { resolveServerToggleAction } from "./serverToggleAction"
import { ProgrammaticWriteGuard } from "./ProgrammaticWriteGuard"
import {
	ensureServersSection,
	readServerEntries,
	readSettingsFile,
	requireServersSection,
	resolveSettingsPath,
	serverOrderFrom,
	type McpSettingsPathResolver,
} from "./mcpSettingsFile"
import { toggleToolInList } from "./mcpToolConfig"
import { createMcpTransport } from "./mcpTransportFactory"
import { parseMcpSettings, validateServerConfig, type ServerConfig } from "./serverConfigSchema"
import { planServerConnectionUpdates } from "./serverUpdatePlan"
import {
	fetchServerResources,
	fetchServerResourceTemplates,
	fetchServerTools,
	requestResourceRead,
	requestToolCall,
} from "./mcpClientQueries"

import { GlobalFileNames } from "../../shared/globalFileNames"

import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspacePath } from "../../utils/path"
import { injectVariables } from "../../utils/config"
import { safeWriteJson } from "../../utils/safeWriteJson"

// 型定義・スキーマは leaf モジュールへ移動済み。既存の import 経路を保つため再エクスポートする。
export {
	DisableReason,
	type ConnectedMcpConnection,
	type DisconnectedMcpConnection,
	type McpConnection,
	type McpTransport,
} from "./mcpConnection"
export { ServerConfigSchema, McpSettingsSchema, type ServerConfig } from "./serverConfigSchema"

export class McpHub {
	private providerRef: WeakRef<McpProviderRef>
	/** サーバごとのファイル監視の所有者。 */
	private readonly serverFileWatchers = new McpServerFileWatchers()
	/** 設定ファイル監視のプランビング（watcher/debounce の所有者）。 */
	private readonly configWatcher: McpConfigWatcher
	private isDisposed: boolean = false
	/** 接続集合の所有者。McpHub は配列を直接持たない。 */
	readonly connectionStore = new McpConnectionStore()
	isConnecting: boolean = false
	private refCount: number = 0 // Reference counter for active clients
	private readonly programmaticWrite = new ProgrammaticWriteGuard()
	/** 設定ファイルの置き場所を解決する seam（global は作成込み、project は無ければ null）。 */
	private readonly settingsPaths: McpSettingsPathResolver = {
		getGlobalSettingsPath: () => this.getMcpSettingsFilePath(),
		getProjectSettingsPath: () => this.getProjectMcpPath(),
	}
	private initializationPromise: Promise<void>

	constructor(provider: McpProviderRef) {
		this.providerRef = new WeakRef(provider)
		this.configWatcher = new McpConfigWatcher({
			getGlobalSettingsPath: () => this.getMcpSettingsFilePath(),
			getProjectCwd: () => this.providerRef.deref()?.cwd ?? getWorkspacePath(),
			isProgrammaticWrite: () => this.programmaticWrite.isActive,
			reloadConfig: (filePath, source) => this.handleConfigFileChange(filePath, source),
			reloadProjectConfig: () => this.updateProjectMcpServers(),
			handleProjectConfigDeleted: () => this.handleProjectConfigDeleted(),
		})
		// テスト環境では実 watcher を張らない（従来 3 メソッドが個別に NODE_ENV で早期 return していた挙動を集約）。
		if (process.env.NODE_ENV !== "test") {
			this.configWatcher.start()
		}
		this.initializationPromise = Promise.all([
			this.initializeGlobalMcpServers(),
			this.initializeProjectMcpServers(),
		]).then(() => {})
	}

	/**
	 * Waits until all MCP servers have finished their initial connection attempts.
	 * Each server individually handles its own timeout, so this will not block indefinitely.
	 */
	async waitUntilReady(): Promise<void> {
		await this.initializationPromise
	}
	/**
	 * Registers a client (e.g., ClineProvider) using this hub.
	 * Increments the reference count.
	 */
	public registerClient(): void {
		this.refCount++
		// console.log(`McpHub: Client registered. Ref count: ${this.refCount}`)
	}

	/**
	 * Unregisters a client. Decrements the reference count.
	 * If the count reaches zero, disposes the hub.
	 */
	public async unregisterClient(): Promise<void> {
		this.refCount--

		// console.log(`McpHub: Client unregistered. Ref count: ${this.refCount}`)

		if (this.refCount <= 0) {
			console.log("McpHub: Last client unregistered. Disposing hub.")
			await this.dispose()
		}
	}

	/**
	 * Formats and displays error messages to the user
	 * @param message The error message prefix
	 * @param error The error object
	 */
	private showErrorMessage(message: string, error: unknown): void {
		console.error(`${message}:`, error)
	}

	private async handleConfigFileChange(filePath: string, source: "global" | "project"): Promise<void> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			const parsed = parseMcpSettings(config)

			if (!parsed.ok) {
				vscode.window.showErrorMessage(
					t("mcp:errors.invalid_settings_validation", { errorMessages: parsed.errorMessages }),
				)
				return
			}

			await this.updateServerConnections(parsed.servers, source)
		} catch (error) {
			// Check if the error is because the file doesn't exist
			if (error.code === "ENOENT" && source === "project") {
				// File was deleted, clean up project MCP servers
				await this.handleProjectConfigDeleted()
			} else {
				this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
			}
		}
	}

	/** プロジェクト設定ファイルが消えた時の後始末（削除イベントと ENOENT の共通処理）。 */
	private async handleProjectConfigDeleted(): Promise<void> {
		await this.cleanupProjectMcpServers()
		await this.notifyWebviewOfServerChanges()
		vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
	}

	private async updateProjectMcpServers(): Promise<void> {
		try {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) return

			const content = await fs.readFile(projectMcpPath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			// Validate configuration structure
			const parsed = parseMcpSettings(config)
			if (parsed.ok) {
				await this.updateServerConnections(parsed.servers, "project")
			} else {
				// Format validation errors for better user feedback
				console.error("Invalid project MCP settings format:", parsed.errorMessages)
				vscode.window.showErrorMessage(
					t("mcp:errors.invalid_settings_validation", { errorMessages: parsed.errorMessages }),
				)
			}
		} catch (error) {
			this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
		}
	}

	private async cleanupProjectMcpServers(): Promise<void> {
		// Disconnect and remove all project MCP servers
		const projectConnections = this.connectionStore.withSource("project")

		for (const conn of projectConnections) {
			await this.deleteConnection(conn.server.name, "project")
		}

		// Clear project servers from the connections list
		await this.updateServerConnections({}, "project", false)
	}

	getServers(): McpServer[] {
		return this.connectionStore.enabledServers()
	}

	getAllServers(): McpServer[] {
		// Return all servers regardless of state
		return this.connectionStore.allServers()
	}

	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(
			await provider.ensureSettingsDirectoryExists(),
			GlobalFileNames.mcpSettings,
		)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {

  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	private async initializeMcpServers(source: "global" | "project"): Promise<void> {
		try {
			const configPath =
				source === "global" ? await this.getMcpSettingsFilePath() : await this.getProjectMcpPath()

			if (!configPath) {
				return
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)
			const parsed = parseMcpSettings(config)

			if (parsed.ok) {
				// Pass all servers including disabled ones - they'll be handled in updateServerConnections
				await this.updateServerConnections(parsed.servers, source, false)
			} else {
				console.error(`Invalid ${source} MCP settings format:`, parsed.errorMessages)
				vscode.window.showErrorMessage(
					t("mcp:errors.invalid_settings_validation", { errorMessages: parsed.errorMessages }),
				)

				if (source === "global") {
					// Still try to connect with the raw config, but show warnings
					try {
						await this.updateServerConnections(config.mcpServers || {}, source, false)
					} catch (error) {
						this.showErrorMessage(`Failed to initialize ${source} MCP servers with raw config`, error)
					}
				}
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, error)
				vscode.window.showErrorMessage(errorMessage)
			} else {
				this.showErrorMessage(`Failed to initialize ${source} MCP servers`, error)
			}
		}
	}

	private async initializeGlobalMcpServers(): Promise<void> {
		await this.initializeMcpServers("global")
	}

	// Get project-level MCP configuration path
	private async getProjectMcpPath(): Promise<string | null> {
		const workspacePath = this.providerRef.deref()?.cwd ?? getWorkspacePath()
		const projectMcpDir = path.join(workspacePath, ".agent")
		const projectMcpPath = path.join(projectMcpDir, "mcp.json")

		try {
			await fs.access(projectMcpPath)
			return projectMcpPath
		} catch {
			return null
		}
	}

	// Initialize project-level MCP servers
	private async initializeProjectMcpServers(): Promise<void> {
		await this.initializeMcpServers("project")
	}

	/**
	 * Checks if MCP is globally enabled
	 * @returns Promise<boolean> indicating if MCP is enabled
	 */
	private async isMcpEnabled(): Promise<boolean> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return true // Default to enabled if provider is not available
		}
		const state = await provider.getState()
		// state.mcpEnabled is `unknown` through the McpProviderRef seam; the
		// real ClineProvider always returns a boolean here.
		return (state.mcpEnabled as boolean | undefined) ?? true
	}

	/** project ソースのサーバに付ける、現在のワークスペースパス。 */
	private currentProjectPath(source: "global" | "project"): string | undefined {
		return source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined
	}

	/**
	 * サーバへの接続を確立する（既存接続があれば張り直す）。
	 *
	 * 3 分岐のゲート（{@link resolveConnectPlan}）を抜けたあとは分岐のない直列手続き。
	 * エラー記録が「store にレコードを積んだ後かどうか」で変わるため、try は
	 * transport 生成〜capabilities 取得までを 1 つの塊で覆っている
	 * （手続きを細切れにすると {@link recordConnectionFailure} の条件が崩れる）。
	 */
	private async connectToServer(
		name: string,
		config: ServerConfig,
		source: "global" | "project" = "global",
	): Promise<void> {
		// Remove existing connection if it exists with the same source
		await this.deleteConnection(name, source)

		// Register the sanitized name for O(1) lookup
		this.connectionStore.rememberName(name)

		const plan = resolveConnectPlan(await this.isMcpEnabled(), config.disabled)

		if (plan !== "connect") {
			// Still create a connection object to track the server, but don't actually connect
			const reason = plan === "mcp-disabled" ? DisableReason.MCP_DISABLED : DisableReason.SERVER_DISABLED
			this.connectionStore.add(
				createPlaceholderConnection({
					name,
					config,
					source,
					reason,
					projectPath: this.currentProjectPath(source),
				}),
			)
			return
		}

		// Set up file watchers for enabled servers
		this.setupFileWatcher(name, config, source)

		try {
			const client = new Client(
				{
					name: "Agent",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)

			// Inject variables to the config (environment, magic variables,...)
			const injectedConfig = (await injectVariables(config, {
				env: process.env,
				workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
			})) as typeof config

			const transport = await createMcpTransport(
				name,
				injectedConfig,
				makeConnectionTransportHandlers({
					connections: this.connectionStore,
					notify: () => this.notifyWebviewOfServerChanges(),
					serverName: name,
					source,
				}),
			)

			const connection = createConnectedConnection({
				name,
				declaredConfig: config,
				source,
				projectPath: this.currentProjectPath(source),
				client,
				transport,
			})
			this.connectionStore.add(connection)

			// Connect (this will automatically start the transport)
			await client.connect(transport)
			connection.server.status = "connected"
			connection.server.error = ""
			connection.server.instructions = client.getInstructions()

			// Initial fetch of tools and resources
			await this.refreshServerCapabilities(connection.server, name, source)
		} catch (error) {
			recordConnectionFailure(this.connectionStore, name, source, error)
			throw error
		}
	}

	/**
	 * Find a connection by sanitized server name.
	 * This is used when parsing MCP tool responses where the server name has been
	 * sanitized (e.g., hyphens replaced with underscores) for API compliance.
	 * Uses fuzzy matching to handle cases where models convert hyphens to underscores.
	 * @param sanitizedServerName The sanitized server name from the API tool call
	 * @returns The original server name if found, or null if no match
	 */
	public findServerNameBySanitizedName(sanitizedServerName: string): string | null {
		return this.connectionStore.resolveName(sanitizedServerName)
	}

	async deleteConnection(name: string, source?: "global" | "project"): Promise<void> {
		// Clean up file watchers for this server
		this.serverFileWatchers.removeFor(name)

		// If source is provided, only delete connections from that source
		const connections = this.connectionStore.matching(name, source)

		for (const connection of connections) {
			try {
				if (connection.type === "connected") {
					await connection.transport.close()
					await connection.client.close()
				}
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
		}

		// Remove the connections (drops the sanitized-name entry once none remain)
		this.connectionStore.remove(name, source)
	}

	async updateServerConnections(
		newServers: Record<string, any>,
		source: "global" | "project" = "global",
		manageConnectingState: boolean = true,
	): Promise<void> {
		if (manageConnectingState) {
			this.isConnecting = true
		}
		this.serverFileWatchers.removeAll()

		// 判断（何をどう扱うか）は純粋関数へ切り出し、ここは副作用（実接続・watcher・通知）だけを行う。
		const plan = planServerConnectionUpdates(newServers, this.connectionStore.namesOwnedBy(source), (name) =>
			this.connectionStore.find(name, source),
		)

		for (const name of plan.toDelete) {
			await this.deleteConnection(name, source)
		}

		for (const action of plan.actions) {
			if (action.kind === "invalid") {
				this.showErrorMessage(`Invalid configuration for MCP server "${action.name}"`, action.error)
				continue
			}

			try {
				// Only setup file watcher for enabled servers
				if (!action.config.disabled) {
					this.setupFileWatcher(action.name, action.config, source)
				}
				if (action.kind === "reconnect") {
					await this.deleteConnection(action.name, source)
				}
				await this.connectToServer(action.name, action.config, source)
			} catch (error) {
				const message =
					action.kind === "connect"
						? `Failed to connect to new MCP server ${action.name}`
						: `Failed to reconnect MCP server ${action.name}`
				this.showErrorMessage(message, error)
			}
		}

		await this.notifyWebviewOfServerChanges()
		if (manageConnectingState) {
			this.isConnecting = false
		}
	}

	/** サーバの監視対象を購読し、変更されたら再接続する。 */
	private setupFileWatcher(name: string, config: ServerConfig, source: "global" | "project" = "global"): void {
		this.serverFileWatchers.watch(name, config, async () => {
			// Pass the source from the config to restartConnection
			await this.restartConnection(name, source)
		})
	}

	async restartConnection(serverName: string, source?: "global" | "project"): Promise<void> {
		this.isConnecting = true

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			this.isConnecting = false
			return
		}

		// Get existing connection and update its status
		const connection = this.connectionStore.find(serverName, source)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(t("mcp:info.server_restarting", { serverName }))
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await delay(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName, connection.server.source)
				// Parse the config to validate it
				const parsedConfig = JSON.parse(config)
				try {
					// Validate the config
					const validatedConfig = validateServerConfig(parsedConfig, serverName)

					// Try to connect again using validated config
					await this.connectToServer(serverName, validatedConfig, connection.server.source || "global")
					vscode.window.showInformationMessage(t("mcp:info.server_connected", { serverName }))
				} catch (validationError) {
					this.showErrorMessage(`Invalid configuration for MCP server "${serverName}"`, validationError)
				}
			} catch (error) {
				this.showErrorMessage(`Failed to restart ${serverName} MCP server connection`, error)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	public async refreshAllConnections(): Promise<void> {
		if (this.isConnecting) {
			return
		}

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Clear all existing connections
			const existingConnections = this.connectionStore.snapshot()
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Still initialize servers to track them, but they won't connect
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await this.notifyWebviewOfServerChanges()
			return
		}

		this.isConnecting = true

		try {
			const globalPath = await this.getMcpSettingsFilePath()
			try {
				const globalContent = await fs.readFile(globalPath, "utf-8")
				JSON.parse(globalContent)
			} catch (error) {
				console.log("Error reading global MCP config:", error)
			}

			const projectPath = await this.getProjectMcpPath()
			if (projectPath) {
				try {
					const projectContent = await fs.readFile(projectPath, "utf-8")
					JSON.parse(projectContent)
				} catch (error) {
					console.log("Error reading project MCP config:", error)
				}
			}

			// Clear all existing connections first
			const existingConnections = this.connectionStore.snapshot()
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize all servers from scratch
			// This ensures proper initialization including fetching tools, resources, etc.
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await delay(100)

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage("Failed to refresh MCP servers", error)
		} finally {
			this.isConnecting = false
		}
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		// 表示順は設定ファイルの記述順に合わせる。global は読めなければ致命的として伝播させ、
		// project は「無い / 壊れている」を許容して空順序にする（既存の方針差をそのまま保つ）。
		const globalServerOrder = serverOrderFrom(await readServerEntries(this.settingsPaths, "global"))

		let projectServerOrder: string[] = []
		try {
			projectServerOrder = serverOrderFrom(await readServerEntries(this.settingsPaths, "project"))
		} catch (_error) {
			// Silently continue with empty project server order
		}

		// Sort connections: first project servers in their defined order, then global servers in their defined order
		const serversToSend = this.connectionStore.serversInConfigOrder({
			global: globalServerOrder,
			project: projectServerOrder,
		})

		// Send sorted servers to webview
		const targetProvider: McpProviderRef | undefined = this.providerRef.deref()

		if (targetProvider) {
			const message = {
				type: "mcpServers" as const,
				mcpServers: serversToSend,
			}

			try {
				await targetProvider.postMessageToWebview(message)
			} catch (error) {
				console.error("[McpHub] Error calling targetProvider.postMessageToWebview:", error)
			}
		} else {
			console.error(
				"[McpHub] No target provider available (neither from getInstance nor providerRef) - cannot send mcpServers message to webview",
			)
		}
	}

	public async toggleServerDisabled(
		serverName: string,
		disabled: boolean,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.connectionStore.find(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { disabled }, serverSource)

			const action = resolveServerToggleAction(disabled, connection.server.status)

			try {
				connection.server.disabled = disabled

				if (action === "reconnect-as-disabled") {
					// Clean up file watchers when disabling
					this.serverFileWatchers.removeFor(serverName)
					await this.deleteConnection(serverName, serverSource)
					// Re-add as a disabled connection (re-read to pick up the new disabled state)
					await this.reconnectFromFile(serverName, serverSource)
				} else if (action === "reconnect-as-enabled") {
					// When re-enabling, file watchers will be set up in connectToServer
					await this.reconnectFromFile(serverName, serverSource, { deleteFirst: true })
				} else if (action === "refresh-capabilities") {
					await this.refreshServerCapabilities(connection.server, serverName, serverSource)
				}
			} catch (error) {
				console.error(`Failed to refresh capabilities for ${serverName}:`, error)
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} state`, error)
			throw error
		}
	}

	/**
	 * 設定ファイルを読み直してサーバに繋ぎ直す。
	 *
	 * `deleteFirst` が false のとき、既存接続の削除は呼び出し側が済ませている前提
	 * （無効化の経路は watcher の後始末を挟むため削除の位置が異なる）。
	 */
	private async reconnectFromFile(
		serverName: string,
		source: "global" | "project",
		options: { deleteFirst?: boolean } = {},
	): Promise<void> {
		const updatedConfig = await this.readServerConfigFromFile(serverName, source)

		if (options.deleteFirst) {
			await this.deleteConnection(serverName, source)
		}

		await this.connectToServer(serverName, updatedConfig, source)
	}

	/** 接続を保ったままツール/リソース一覧を取り直す。 */
	private async refreshServerCapabilities(
		server: McpServer,
		serverName: string,
		source: "global" | "project",
	): Promise<void> {
		const connection = this.connectionStore.find(serverName, source)
		server.tools = await fetchServerTools(connection, this.settingsPaths)
		server.resources = await fetchServerResources(connection)
		server.resourceTemplates = await fetchServerResourceTemplates(connection)
	}

	/**
	 * Helper method to read a server's configuration from the appropriate settings file
	 * @param serverName The name of the server to read
	 * @param source Whether to read from the global or project config
	 * @returns The validated server configuration
	 */
	private async readServerConfigFromFile(
		serverName: string,
		source: "global" | "project" = "global",
	): Promise<ServerConfig> {
		const configPath = await resolveSettingsPath(this.settingsPaths, source)
		const config = await readSettingsFile(configPath)
		const servers = requireServersSection(config)

		if (!servers[serverName]) {
			throw new Error(`Server ${serverName} not found in config`)
		}

		// Validate and return the server config
		return validateServerConfig(servers[serverName], serverName)
	}

	/**
	 * Helper method to update a server's configuration in the appropriate settings file
	 * @param serverName The name of the server to update
	 * @param configUpdate The configuration updates to apply
	 * @param source Whether to update the global or project config
	 */
	private async updateServerConfig(
		serverName: string,
		configUpdate: Record<string, any>,
		source: "global" | "project" = "global",
	): Promise<void> {
		const configPath = await resolveSettingsPath(this.settingsPaths, source)
		const config = await readSettingsFile(configPath)
		const servers = ensureServersSection(config)

		// Create a new server config object to ensure clean structure
		const serverConfig = {
			...(servers[serverName] ?? {}),
			...configUpdate,
		}

		// Ensure required fields exist
		if (!serverConfig.alwaysAllow) {
			serverConfig.alwaysAllow = []
		}

		servers[serverName] = serverConfig

		// Write the entire config back
		const updatedConfig = { mcpServers: servers }

		// Guard the write so our own change notification doesn't restart the server
		await this.programmaticWrite.run(() => safeWriteJson(configPath, updatedConfig, { prettyPrint: true }))
	}

	public async updateServerTimeout(
		serverName: string,
		timeout: number,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.connectionStore.find(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { timeout }, connection.server.source || "global")

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
			throw error
		}
	}

	public async deleteServer(serverName: string, source?: "global" | "project"): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.connectionStore.find(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			const configPath = await resolveSettingsPath(this.settingsPaths, serverSource)
			const config = await readSettingsFile(configPath)
			const servers = ensureServersSection(config)

			// Remove the server from the settings
			if (servers[serverName]) {
				delete servers[serverName]

				// Write the entire config back
				const updatedConfig = { mcpServers: servers }

				// Guard the write so our own change notification doesn't restart the
				// remaining servers a second time (this method reconciles them itself below).
				await this.programmaticWrite.run(() => safeWriteJson(configPath, updatedConfig, { prettyPrint: true }))

				// Update server connections with the correct source
				await this.updateServerConnections(servers, serverSource)

				vscode.window.showInformationMessage(t("mcp:info.server_deleted", { serverName }))
			} else {
				vscode.window.showWarningMessage(t("mcp:info.server_not_found", { serverName }))
			}
		} catch (error) {
			this.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
			throw error
		}
	}

	async readResource(serverName: string, uri: string, source?: "global" | "project"): Promise<McpResourceResponse> {
		const connection = this.connectionStore.find(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		return await requestResourceRead(connection, uri)
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
		source?: "global" | "project",
	): Promise<McpToolCallResponse> {
		const connection = this.connectionStore.find(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(
				`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		return await requestToolCall(connection, toolName, toolArguments)
	}

	/**
	 * Helper method to update a specific tool list (alwaysAllow or disabledTools)
	 * in the appropriate settings file.
	 * @param serverName The name of the server to update
	 * @param source Whether to update the global or project config
	 * @param toolName The name of the tool to add or remove
	 * @param listName The name of the list to modify ("alwaysAllow" or "disabledTools")
	 * @param addTool Whether to add (true) or remove (false) the tool from the list
	 */
	private async updateServerToolList(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		listName: "alwaysAllow" | "disabledTools",
		addTool: boolean,
	): Promise<void> {
		// Find the connection with matching name and source
		const connection = this.connectionStore.find(serverName, source)

		if (!connection) {
			throw new Error(`Server ${serverName} with source ${source} not found`)
		}

		const configPath = await resolveSettingsPath(this.settingsPaths, source)

		// Normalize path for cross-platform compatibility
		// Use a consistent path format for both reading and writing
		const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath

		// Read the appropriate config file (access check is skipped: the path was just resolved)
		const content = await fs.readFile(normalizedPath, "utf-8")
		const config = JSON.parse(content)
		const servers = ensureServersSection(config)

		if (!servers[serverName]) {
			servers[serverName] = {
				type: "stdio",
				command: "node",
				args: [], // Default to an empty array; can be set later if needed
			}
		}

		servers[serverName][listName] = toggleToolInList(servers[serverName][listName], toolName, addTool)

		// Guard the write so our own change notification doesn't restart the server
		await this.programmaticWrite.run(() => safeWriteJson(normalizedPath, config, { prettyPrint: true }))

		if (connection) {
			connection.server.tools = await fetchServerTools(connection, this.settingsPaths)
			await this.notifyWebviewOfServerChanges()
		}
	}

	async toggleToolAlwaysAllow(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		shouldAllow: boolean,
	): Promise<void> {
		try {
			await this.updateServerToolList(serverName, source, toolName, "alwaysAllow", shouldAllow)
		} catch (error) {
			this.showErrorMessage(
				`Failed to toggle always allow for tool "${toolName}" on server "${serverName}" with source "${source}"`,
				error,
			)
			throw error
		}
	}

	async toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		isEnabled: boolean,
	): Promise<void> {
		try {
			// When isEnabled is true, we want to remove the tool from the disabledTools list.
			// When isEnabled is false, we want to add the tool to the disabledTools list.
			const addToolToDisabledList = !isEnabled
			await this.updateServerToolList(serverName, source, toolName, "disabledTools", addToolToDisabledList)
		} catch (error) {
			this.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	/**
	 * Handles enabling/disabling MCP globally
	 * @param enabled Whether MCP should be enabled or disabled
	 * @returns Promise<void>
	 */
	async handleMcpEnabledChange(enabled: boolean): Promise<void> {
		if (!enabled) {
			// If MCP is being disabled, disconnect all servers with error handling
			const existingConnections = this.connectionStore.snapshot()
			const disconnectionErrors: Array<{ serverName: string; error: string }> = []

			for (const conn of existingConnections) {
				try {
					await this.deleteConnection(conn.server.name, conn.server.source)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					disconnectionErrors.push({
						serverName: conn.server.name,
						error: errorMessage,
					})
					console.error(`Failed to disconnect MCP server ${conn.server.name}: ${errorMessage}`)
				}
			}

			// If there were errors, notify the user
			if (disconnectionErrors.length > 0) {
				const errorSummary = disconnectionErrors.map((e) => `${e.serverName}: ${e.error}`).join("\n")
				vscode.window.showWarningMessage(
					t("mcp:errors.disconnect_servers_partial", {
						count: disconnectionErrors.length,
						errors: errorSummary,
					}),
				)
			}

			// Re-initialize servers to track them in disconnected state
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after disabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_disable"))
			}
		} else {
			// If MCP is being enabled, reconnect all servers
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after enabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_enable"))
			}
		}
	}

	async dispose(): Promise<void> {
		// Prevent multiple disposals
		if (this.isDisposed) {
			return
		}

		this.isDisposed = true

		this.configWatcher.dispose()

		this.programmaticWrite.dispose()
		this.serverFileWatchers.removeAll()

		for (const connection of this.connectionStore.items) {
			try {
				await this.deleteConnection(connection.server.name, connection.server.source)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}

		this.connectionStore.clear()
	}
}
