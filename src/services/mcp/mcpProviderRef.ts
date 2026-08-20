// Leaf module holding the narrow shape that McpHub / McpServerManager need
// from their hosting ClineProvider. Defining this here (instead of pulling in
// ClineProvider) breaks the mcp ↔ webview cycle: ClineProvider structurally
// satisfies the shape, so the concrete class doesn't have to know about it.

/**
 * Minimal surface of the ClineProvider that mcp code consumes.
 *
 * Only add fields here that mcp/ actually calls. Growing this interface has a
 * cost — every extra field is a new coupling point that a future mcp change
 * has to keep honouring.
 *
 * Method params/returns are typed loose (`unknown` / `Record<string, unknown>`)
 * so this leaf module has no dependencies of its own — pulling in
 * WebviewMessage or ExtensionState would reintroduce the very cycle this file
 * exists to break. mcp code accesses the values structurally.
 */
export interface McpProviderRef {
	/** Workspace path used to resolve project-scoped MCP config. */
	readonly cwd: string

	/** VS Code extension context, used for reading `packageJSON.version`. */
	readonly context: {
		readonly extension?: {
			readonly packageJSON?: {
				readonly version?: string
			}
		}
	}

	postMessageToWebview(message: unknown): Promise<unknown>
	ensureSettingsDirectoryExists(): Promise<string>
	getState(): Promise<Record<string, unknown>>
}
