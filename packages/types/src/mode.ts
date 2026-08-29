import { z } from "zod"

import { deprecatedToolGroups, toolGroupsSchema, type ToolGroup } from "./tool.js"

/**
 * Mode tool groups.
 *
 * かつては `["edit", { fileRegex }]` のようなオプション付きタプルも受理したが、
 * fileRegex はカスタムモード（撤去済み）でしか表現できなかったため、グループ名の
 * 配列だけを受理する。旧設定との互換のため、廃止済みグループ（browser）と
 * タプル形式のエントリは検証前に黙って取り除く。
 */
function isDeprecatedGroupEntry(entry: unknown): boolean {
	if (typeof entry === "string") {
		return deprecatedToolGroups.includes(entry)
	}
	return false
}

const rawGroupEntryArraySchema = z.array(toolGroupsSchema).refine(
	(groups) => {
		const seen = new Set()

		return groups.every((group) => {
			if (seen.has(group)) {
				return false
			}

			seen.add(group)
			return true
		})
	},
	{ message: "Duplicate groups are not allowed" },
)

export const groupEntryArraySchema = z.preprocess((val) => {
	if (!Array.isArray(val)) return val
	return val
		.map((entry) => (Array.isArray(entry) && entry.length >= 1 ? entry[0] : entry))
		.filter((entry) => !isDeprecatedGroupEntry(entry))
}, rawGroupEntryArraySchema) as z.ZodType<ToolGroup[], z.ZodTypeDef, ToolGroup[]>

export const modeConfigSchema = z.object({
	slug: z.string().regex(/^[a-zA-Z0-9-]+$/, "Slug must contain only letters numbers and dashes"),
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema,
})

export type ModeConfig = z.infer<typeof modeConfigSchema>

/**
 * PromptComponent
 */

export const promptComponentSchema = z.object({
	roleDefinition: z.string().optional(),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
})

export type PromptComponent = z.infer<typeof promptComponentSchema>

/**
 * CustomModePrompts
 */

export const customModePromptsSchema = z.record(z.string(), promptComponentSchema.optional())

export type CustomModePrompts = z.infer<typeof customModePromptsSchema>

/**
 * CustomSupportPrompts
 */

export const customSupportPromptsSchema = z.record(z.string(), z.string().optional())

export type CustomSupportPrompts = z.infer<typeof customSupportPromptsSchema>

/**
 * DEFAULT_MODES
 */

export const DEFAULT_MODES: readonly ModeConfig[] = [
	{
		slug: "code",
		name: "💻 Code",
		roleDefinition:
			"You are a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
		whenToUse:
			"Use this mode when you need to write, modify, or refactor code. Ideal for implementing features, fixing bugs, creating new files, or making code improvements across any programming language or framework.",
		description: "Write, modify, and refactor code",
		groups: ["read", "edit", "command", "mcp"],
	},
	{
		slug: "research",
		name: "🔍 Research & Ops",
		roleDefinition:
			"You are a hands-on technical investigator and operator. Your work is understanding and operating systems, not programming: you trace how things actually behave, collect logs and diagnostics, inspect live state, research official manuals and GitHub (issues, repositories, release notes), and adjust configuration (e.g. Kubernetes manifests, CI pipelines, tool settings) when the task calls for it. Before applying a procedure, verify it against the documentation for the versions actually in use. You back every finding with evidence — file paths, line numbers, command output, and the sources you consulted (URLs, document titles) — and clearly separate what you verified from what you infer. You do not write application code; that is Code mode's job.",
		whenToUse:
			"Use this mode when the work is investigation or operations rather than writing code: exploring how a codebase or system works, digging into the cause of a behavior, gathering logs and diagnostics, researching manuals or community knowledge and verifying procedures against them, comparing approaches or libraries, or configuring infrastructure and tooling.",
		description: "Investigate, gather logs, adjust configuration",
		groups: ["read", "edit", "command", "mcp"],
	},
] as const
