import type { ContextProxy } from "../../config/ContextProxy"

// Narrow surface that worktree handler functions need from their hosting
// ClineProvider. Defining this here (instead of importing ClineProvider
// directly) breaks the webview cluster cycle
// `webviewMessageHandler → worktree/index → worktree/handlers → ClineProvider
// → webviewMessageHandler`.
//
// Only add fields that worktree/handlers.ts actually calls — currently
// contextProxy (for setValue), cwd, and log.

export interface WorktreeHandlerHost {
	readonly contextProxy: ContextProxy
	readonly cwd: string
	log(message: string): void
}
