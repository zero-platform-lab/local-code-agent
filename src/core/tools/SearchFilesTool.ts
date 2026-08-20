import path from "path"

import { type ClineSayTool } from "@openai-agent/types"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { regexSearchFiles } from "../../services/ripgrep"
import type { ToolUse } from "../../shared/tools"
import type { AgentIgnoreController } from "../ignore/AgentIgnoreController"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolTaskContext } from "./toolHost"

interface SearchFilesParams {
	path: string
	regex: string
	file_pattern?: string | null
}

/** Narrow structural view of `Task` required by {@link SearchFilesTool}. */
interface SearchFilesHost extends ToolTaskContext {
	stream: {
		didToolFailInCurrentTurn: boolean
	}
	readonly cwd: string
	readonly rooIgnoreController?: AgentIgnoreController
}

export class SearchFilesTool extends BaseTool<"search_files"> {
	readonly name = "search_files" as const

	async execute(params: SearchFilesParams, task: SearchFilesHost, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		const relDirPath = params.path
		const regex = params.regex
		const filePattern = params.file_pattern || undefined

		if (!relDirPath) {
			task.mistakeTracker.count++
			task.tokenUsageTracker.recordToolError("search_files")
			task.stream.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "path"))
			return
		}

		if (!regex) {
			task.mistakeTracker.count++
			task.tokenUsageTracker.recordToolError("search_files")
			task.stream.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "regex"))
			return
		}

		task.mistakeTracker.count = 0

		const absolutePath = path.resolve(task.cwd, relDirPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath),
			regex: regex,
			filePattern: filePattern,
			isOutsideWorkspace,
		}

		try {
			const results = await regexSearchFiles(task.cwd, absolutePath, regex, filePattern, task.rooIgnoreController)

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: results } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(results)
		} catch (error) {
			await handleError("searching files", error as Error)
		}
	}

	override async handlePartial(task: SearchFilesHost, block: ToolUse<"search_files">): Promise<void> {
		const relDirPath = block.params.path
		const regex = block.params.regex
		const filePattern = block.params.file_pattern

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			regex: regex ?? "",
			filePattern: filePattern ?? "",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const searchFilesTool = new SearchFilesTool()
