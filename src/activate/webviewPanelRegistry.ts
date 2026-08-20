import * as vscode from "vscode"

// Module-level state that used to live in `registerCommands.ts`. Extracted
// into this leaf so `ClineProvider` (which needs `setPanel`) can consume it
// without importing `registerCommands.ts`, which imports `ClineProvider` back
// — breaking the module cycle between the two.

let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel.
 * Prefers the tab panel over the sidebar when both would somehow be set.
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/** Access the underlying tab / sidebar panel refs individually. */
export function getTabPanel(): vscode.WebviewPanel | undefined {
	return tabPanel
}
export function getSidebarPanel(): vscode.WebviewView | undefined {
	return sidebarPanel
}

/**
 * Set the active panel reference. Only one of sidebar / tab is live at a time;
 * setting one clears the other.
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}
