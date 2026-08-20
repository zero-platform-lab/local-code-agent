import type { ClineSayTool } from "@openai-agent/types"

export function isWriteToolAction(tool: ClineSayTool): boolean {
	return ["editedExistingFile", "appliedDiff", "newFileCreated"].includes(tool.tool)
}

export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	return [
		"readFile",
		"listFiles",
		"listFilesTopLevel",
		"listFilesRecursive",
		"searchFiles",
		"codebaseSearch",
		"runSlashCommand",
	].includes(tool.tool)
}
