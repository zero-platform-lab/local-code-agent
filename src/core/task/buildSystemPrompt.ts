import type * as vscode from "vscode"

import pWaitFor from "p-wait-for"

import type { AutonomyMode } from "@openai-agent/types"

import { Package } from "../../shared/package"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { defaultModeSlug } from "../../shared/modes"
import type { DiffStrategy } from "../../shared/tools"
import { SYSTEM_PROMPT } from "../prompts/system"

/**
 * `Task.getSystemPrompt()` の実装を切り出したモジュール。
 *
 * 呼び出し側では
 *
 *   private async getSystemPrompt(): Promise<string> {
 *     return await buildSystemPrompt({ providerRef, api, cwd, diffStrategy, rooIgnoreController })
 *   }
 *
 * とすれば、既存の spyOn ベーステスト（`Task.spec.ts` で `vi.spyOn(x as any, "getSystemPrompt")`）
 * は method 経由で mock できるので互換性が保たれる。
 */

interface SystemPromptProvider {
	context: vscode.ExtensionContext
	getState(): Promise<
		| {
				mcpEnabled?: boolean
				mode?: string
				customModes?: unknown
				customModePrompts?: unknown
				customInstructions?: string
				experiments?: unknown
				language?: unknown
				apiConfiguration?: { todoListEnabled?: boolean }
				enableSubfolderRules?: boolean
				autonomyMode?: AutonomyMode
		  }
		| undefined
	>
	getSkillsManager(): unknown
}

export interface BuildSystemPromptDeps {
	providerRef: WeakRef<SystemPromptProvider>
	api: { getModel(): { info: { isStealthModel?: boolean }; id: string } }
	cwd: string
	diffStrategy?: DiffStrategy
	rooIgnoreController?: { getInstructions(): string | undefined }
	vscode: typeof vscode
}

export async function buildSystemPrompt(deps: BuildSystemPromptDeps): Promise<string> {
	const { mcpEnabled } = (await deps.providerRef.deref()?.getState()) ?? {}
	let mcpHub: McpHub | undefined
	if (mcpEnabled ?? true) {
		const provider = deps.providerRef.deref()

		if (!provider) {
			throw new Error("Provider reference lost during view transition")
		}

		// Wait for MCP hub initialization through McpServerManager
		mcpHub = await McpServerManager.getInstance(provider.context, provider as never)

		if (!mcpHub) {
			throw new Error("Failed to get MCP hub from server manager")
		}

		// Wait for MCP servers to be connected before generating system prompt
		await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
			console.error("MCP servers failed to connect in time")
		})
	}

	const rooIgnoreInstructions = deps.rooIgnoreController?.getInstructions()

	const state = await deps.providerRef.deref()?.getState()

	const {
		mode,
		customModes,
		customModePrompts,
		customInstructions,
		experiments,
		language,
		apiConfiguration,
		enableSubfolderRules,
		autonomyMode,
	} = state ?? {}

	const provider = deps.providerRef.deref()

	if (!provider) {
		throw new Error("Provider not available")
	}

	const modelInfo = deps.api.getModel().info

	return SYSTEM_PROMPT(
		provider.context,
		deps.cwd,
		false,
		mcpHub,
		deps.diffStrategy,
		(mode as string | undefined) ?? defaultModeSlug,
		customModePrompts as never,
		customModes as never,
		customInstructions,
		experiments as never,
		language as never,
		rooIgnoreInstructions,
		{
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: deps.vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
			enableSubfolderRules: enableSubfolderRules ?? false,
			newTaskRequireTodos: deps.vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: modelInfo?.isStealthModel,
			autonomyMode,
		},
		undefined, // todoList
		deps.api.getModel().id,
		provider.getSkillsManager() as never,
	)
}
