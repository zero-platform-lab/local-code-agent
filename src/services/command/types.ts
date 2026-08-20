/**
 * Shared slash-command types.
 *
 * Extracted into a leaf module so that `built-in-commands.ts` can consume the
 * `Command` shape without importing `commands.ts` (which imports back from
 * `built-in-commands.ts`), breaking the module cycle between the two.
 */
export interface Command {
	name: string
	content: string
	source: "global" | "project" | "built-in"
	filePath: string
	description?: string
	argumentHint?: string
	mode?: string
}
