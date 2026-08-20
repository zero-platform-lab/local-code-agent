import * as path from "path"

import { type ClineSayTool } from "@openai-agent/types"

import { formatResponse } from "../prompts/responses"
import { listFiles } from "../../services/glob/list-files"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"
import type { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import type { AgentProtectedController } from "../protect/AgentProtectedController"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolTaskContext } from "./toolHost"

interface ListFilesParams {
	path: string
	recursive?: boolean
}

interface ListFilesProviderLike {
	getState(): Promise<{ showAgentIgnoredFiles?: boolean }>
}

/** Narrow structural view of `Task` required by {@link ListFilesTool}. */
interface ListFilesHost extends ToolTaskContext {
	stream: {
		didToolFailInCurrentTurn: boolean
	}
	readonly cwd: string
	readonly providerRef: WeakRef<ListFilesProviderLike>
	readonly rooIgnoreController?: AgentIgnoreController
	readonly rooProtectedController?: AgentProtectedController
}

export class ListFilesTool extends BaseTool<"list_files"> {
	readonly name = "list_files" as const

	async execute(params: ListFilesParams, task: ListFilesHost, callbacks: ToolCallbacks): Promise<void> {
		const { path: relDirPath, recursive } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!relDirPath) {
				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("list_files")
				task.stream.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_files", "path"))
				return
			}

			task.mistakeTracker.count = 0

			const absolutePath = path.resolve(task.cwd, relDirPath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const [files, didHitLimit] = await listFiles(absolutePath, recursive || false, 200)
			const { showAgentIgnoredFiles = false } = (await task.providerRef.deref()?.getState()) ?? {}

			const result = formatResponse.formatFilesList(
				absolutePath,
				files,
				didHitLimit,
				task.rooIgnoreController,
				showAgentIgnoredFiles,
				task.rooProtectedController,
			)

			const sharedMessageProps: ClineSayTool = {
				tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
				path: getReadablePath(task.cwd, relDirPath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: result } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(result)
		} catch (error) {
			await handleError("listing files", error)
		}
	}

	override async handlePartial(task: ListFilesHost, block: ToolUse<"list_files">): Promise<void> {
		const relDirPath: string | undefined = block.params.path
		const recursiveRaw: string | undefined = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const listFilesTool = new ListFilesTool()
