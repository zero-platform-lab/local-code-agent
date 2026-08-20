import * as vscode from "vscode"
import delay from "delay"

import type { CodeActionId, CodeActionName, TerminalActionId, TerminalActionPromptType } from "@openai-agent/types"

import { findLast } from "../../shared/array"
import { Package } from "../../shared/package"

import { runCodeAction, runTerminalAction, type SupportPromptActionTarget } from "./supportPromptActions"

// Registry of live ClineProvider instances, plus static "dispatch to visible
// provider" helpers. Extracted from ClineProvider.ts so the class body doesn't
// have to own module-level state and command dispatch logic itself — a first
// step toward slimming the god-object.
//
// The registry only needs the minimal shape below (view visibility check + a
// `getCurrentTask()` for isActiveTask), so we don't import the concrete
// ClineProvider type here — avoiding a cycle. handleCodeAction /
// handleTerminalAction additionally require the SupportPromptActionTarget
// shape (getState / postMessageToWebview / createTask), so the interface
// intersects both.

export interface RegisteredProvider extends SupportPromptActionTarget {
	isVisible(): boolean
	getCurrentTask(): unknown
}

const activeInstances = new Set<RegisteredProvider>()

/** Called from ClineProvider's constructor. */
export function registerProvider(provider: RegisteredProvider): void {
	activeInstances.add(provider)
}

/** Called from ClineProvider's dispose(). */
export function unregisterProvider(provider: RegisteredProvider): void {
	activeInstances.delete(provider)
}

/** Return the newest active provider whose webview is currently visible. */
export function getVisibleProvider(): RegisteredProvider | undefined {
	return findLast(Array.from(activeInstances), (instance) => instance.isVisible())
}

/**
 * Same as {@link getVisibleProvider} but, if none is visible, first focuses
 * the sidebar and retries. Used by commands invoked outside a webview context.
 */
export async function getVisibleInstance(): Promise<RegisteredProvider | undefined> {
	let visibleProvider = getVisibleProvider()

	if (!visibleProvider) {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		// Wait briefly for the view to become visible.
		await delay(100)
		visibleProvider = getVisibleProvider()
	}

	return visibleProvider
}

export async function isActiveTask(): Promise<boolean> {
	const visibleProvider = await getVisibleInstance()
	if (!visibleProvider) return false
	return visibleProvider.getCurrentTask() !== undefined
}

export async function handleCodeAction(
	command: CodeActionId,
	promptType: CodeActionName,
	params: Record<string, string | any[]>,
): Promise<void> {
	const visibleProvider = await getVisibleInstance()
	if (!visibleProvider) return
	return runCodeAction(visibleProvider, command, promptType, params)
}

export async function handleTerminalAction(
	command: TerminalActionId,
	promptType: TerminalActionPromptType,
	params: Record<string, string | any[]>,
): Promise<void> {
	const visibleProvider = await getVisibleInstance()
	if (!visibleProvider) return
	return runTerminalAction(visibleProvider, command, promptType, params)
}
