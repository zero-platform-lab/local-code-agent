import { z } from "zod"

import { agentSettingsSchema } from "./global-settings.js"

/**
 * Agent CLI stdin commands
 */

export const agentCliCommandNames = ["start", "message", "cancel", "ping", "shutdown"] as const

export const agentCliCommandNameSchema = z.enum(agentCliCommandNames)

export type AgentCliCommandName = z.infer<typeof agentCliCommandNameSchema>

export const agentCliCommandBaseSchema = z.object({
	command: agentCliCommandNameSchema,
	requestId: z.string().min(1),
})

export type AgentCliCommandBase = z.infer<typeof agentCliCommandBaseSchema>

const agentCliSessionIdSchema = z
	.string()
	.trim()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

export const agentCliStartCommandSchema = agentCliCommandBaseSchema.extend({
	command: z.literal("start"),
	prompt: z.string(),
	taskId: agentCliSessionIdSchema.optional(),
	images: z.array(z.string()).optional(),
	configuration: agentSettingsSchema.optional(),
})

export type AgentCliStartCommand = z.infer<typeof agentCliStartCommandSchema>

export const agentCliMessageCommandSchema = agentCliCommandBaseSchema.extend({
	command: z.literal("message"),
	prompt: z.string(),
	images: z.array(z.string()).optional(),
})

export type AgentCliMessageCommand = z.infer<typeof agentCliMessageCommandSchema>

export const agentCliCancelCommandSchema = agentCliCommandBaseSchema.extend({
	command: z.literal("cancel"),
})

export type AgentCliCancelCommand = z.infer<typeof agentCliCancelCommandSchema>

export const agentCliPingCommandSchema = agentCliCommandBaseSchema.extend({
	command: z.literal("ping"),
})

export type AgentCliPingCommand = z.infer<typeof agentCliPingCommandSchema>

export const agentCliShutdownCommandSchema = agentCliCommandBaseSchema.extend({
	command: z.literal("shutdown"),
})

export type AgentCliShutdownCommand = z.infer<typeof agentCliShutdownCommandSchema>

export const agentCliInputCommandSchema = z.discriminatedUnion("command", [
	agentCliStartCommandSchema,
	agentCliMessageCommandSchema,
	agentCliCancelCommandSchema,
	agentCliPingCommandSchema,
	agentCliShutdownCommandSchema,
])

export type AgentCliInputCommand = z.infer<typeof agentCliInputCommandSchema>

/**
 * Agent CLI stream-json output
 */

export const agentCliOutputFormats = ["text", "json", "stream-json"] as const

export const agentCliOutputFormatSchema = z.enum(agentCliOutputFormats)

export type AgentCliOutputFormat = z.infer<typeof agentCliOutputFormatSchema>

export const agentCliEventTypes = [
	"system",
	"control",
	"queue",
	"assistant",
	"user",
	"tool_use",
	"tool_result",
	"thinking",
	"error",
	"result",
] as const

export const agentCliEventTypeSchema = z.enum(agentCliEventTypes)

export type AgentCliEventType = z.infer<typeof agentCliEventTypeSchema>

export const agentCliControlSubtypes = ["ack", "done", "error"] as const

export const agentCliControlSubtypeSchema = z.enum(agentCliControlSubtypes)

export type AgentCliControlSubtype = z.infer<typeof agentCliControlSubtypeSchema>

export const agentCliQueueItemSchema = z.object({
	id: z.string().min(1),
	text: z.string().optional(),
	imageCount: z.number().optional(),
	timestamp: z.number().optional(),
})

export type AgentCliQueueItem = z.infer<typeof agentCliQueueItemSchema>

export const agentCliToolUseSchema = z.object({
	name: z.string(),
	input: z.record(z.unknown()).optional(),
})

export type AgentCliToolUse = z.infer<typeof agentCliToolUseSchema>

export const agentCliToolResultSchema = z.object({
	name: z.string(),
	output: z.string().optional(),
	error: z.string().optional(),
	exitCode: z.number().optional(),
})

export type AgentCliToolResult = z.infer<typeof agentCliToolResultSchema>

export const agentCliCostSchema = z.object({
	totalCost: z.number().optional(),
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
})

export type AgentCliCost = z.infer<typeof agentCliCostSchema>

export const agentCliStreamEventSchema = z
	.object({
		type: agentCliEventTypeSchema.optional(),
		subtype: z.string().optional(),
		requestId: z.string().optional(),
		command: agentCliCommandNameSchema.optional(),
		taskId: z.string().optional(),
		code: z.string().optional(),
		content: z.string().optional(),
		success: z.boolean().optional(),
		id: z.number().optional(),
		done: z.boolean().optional(),
		queueDepth: z.number().optional(),
		queue: z.array(agentCliQueueItemSchema).optional(),
		schemaVersion: z.number().optional(),
		protocol: z.string().optional(),
		capabilities: z.array(z.string()).optional(),
		tool_use: agentCliToolUseSchema.optional(),
		tool_result: agentCliToolResultSchema.optional(),
		cost: agentCliCostSchema.optional(),
	})
	.passthrough()

export type AgentCliStreamEvent = z.infer<typeof agentCliStreamEventSchema>

export const agentCliControlEventSchema = agentCliStreamEventSchema.extend({
	type: z.literal("control"),
	subtype: agentCliControlSubtypeSchema,
	requestId: z.string().min(1),
})

export type AgentCliControlEvent = z.infer<typeof agentCliControlEventSchema>

export const agentCliFinalOutputSchema = z.object({
	type: z.literal("result"),
	success: z.boolean(),
	content: z.string().optional(),
	cost: agentCliCostSchema.optional(),
	events: z.array(agentCliStreamEventSchema),
})

export type AgentCliFinalOutput = z.infer<typeof agentCliFinalOutputSchema>
