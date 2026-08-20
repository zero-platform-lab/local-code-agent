import { z } from "zod"

import { clineMessageSchema, queuedMessageSchema, tokenUsageSchema } from "./message.js"
import { modelInfoSchema } from "./model.js"
import { toolNamesSchema, toolUsageSchema } from "./tool.js"

/**
 * AgentEventName
 */

export enum AgentEventName {
	// Task Provider Lifecycle
	TaskCreated = "taskCreated",

	// Task Lifecycle
	TaskStarted = "taskStarted",
	TaskCompleted = "taskCompleted",
	TaskAborted = "taskAborted",
	TaskFocused = "taskFocused",
	TaskUnfocused = "taskUnfocused",
	TaskActive = "taskActive",
	TaskInteractive = "taskInteractive",
	TaskResumable = "taskResumable",
	TaskIdle = "taskIdle",

	// Subtask Lifecycle
	TaskPaused = "taskPaused",
	TaskUnpaused = "taskUnpaused",
	TaskSpawned = "taskSpawned",
	TaskDelegated = "taskDelegated",
	TaskDelegationCompleted = "taskDelegationCompleted",
	TaskDelegationResumed = "taskDelegationResumed",

	// Task Execution
	Message = "message",
	TaskModeSwitched = "taskModeSwitched",
	TaskAskResponded = "taskAskResponded",
	TaskUserMessage = "taskUserMessage",
	QueuedMessagesUpdated = "queuedMessagesUpdated",

	// Task Analytics
	TaskTokenUsageUpdated = "taskTokenUsageUpdated",
	TaskToolFailed = "taskToolFailed",

	// Configuration Changes
	ModeChanged = "modeChanged",
	ProviderProfileChanged = "providerProfileChanged",

	// Query Responses
	CommandsResponse = "commandsResponse",
	ModesResponse = "modesResponse",
	ModelsResponse = "modelsResponse",
}

/**
 * AgentEvents
 */

export const agentEventsSchema = z.object({
	[AgentEventName.TaskCreated]: z.tuple([z.string()]),

	[AgentEventName.TaskStarted]: z.tuple([z.string()]),
	[AgentEventName.TaskCompleted]: z.tuple([
		z.string(),
		tokenUsageSchema,
		toolUsageSchema,
		z.object({
			isSubtask: z.boolean(),
		}),
	]),
	[AgentEventName.TaskAborted]: z.tuple([z.string()]),
	[AgentEventName.TaskFocused]: z.tuple([z.string()]),
	[AgentEventName.TaskUnfocused]: z.tuple([z.string()]),
	[AgentEventName.TaskActive]: z.tuple([z.string()]),
	[AgentEventName.TaskInteractive]: z.tuple([z.string()]),
	[AgentEventName.TaskResumable]: z.tuple([z.string()]),
	[AgentEventName.TaskIdle]: z.tuple([z.string()]),

	[AgentEventName.TaskPaused]: z.tuple([z.string()]),
	[AgentEventName.TaskUnpaused]: z.tuple([z.string()]),
	[AgentEventName.TaskSpawned]: z.tuple([z.string(), z.string()]),
	[AgentEventName.TaskDelegated]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),
	[AgentEventName.TaskDelegationCompleted]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
		z.string(), // completionResultSummary
	]),
	[AgentEventName.TaskDelegationResumed]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),

	[AgentEventName.Message]: z.tuple([
		z.object({
			taskId: z.string(),
			action: z.union([z.literal("created"), z.literal("updated")]),
			message: clineMessageSchema,
		}),
	]),
	[AgentEventName.TaskModeSwitched]: z.tuple([z.string(), z.string()]),
	[AgentEventName.TaskAskResponded]: z.tuple([z.string()]),
	[AgentEventName.TaskUserMessage]: z.tuple([z.string()]),
	[AgentEventName.QueuedMessagesUpdated]: z.tuple([z.string(), z.array(queuedMessageSchema)]),

	[AgentEventName.TaskToolFailed]: z.tuple([z.string(), toolNamesSchema, z.string()]),
	[AgentEventName.TaskTokenUsageUpdated]: z.tuple([z.string(), tokenUsageSchema, toolUsageSchema]),

	[AgentEventName.ModeChanged]: z.tuple([z.string()]),
	[AgentEventName.ProviderProfileChanged]: z.tuple([z.object({ name: z.string(), provider: z.string() })]),

	[AgentEventName.CommandsResponse]: z.tuple([
		z.array(
			z.object({
				name: z.string(),
				source: z.enum(["global", "project", "built-in"]),
				filePath: z.string().optional(),
				description: z.string().optional(),
				argumentHint: z.string().optional(),
			}),
		),
	]),
	[AgentEventName.ModesResponse]: z.tuple([z.array(z.object({ slug: z.string(), name: z.string() }))]),
	[AgentEventName.ModelsResponse]: z.tuple([z.record(z.string(), modelInfoSchema)]),
})

export type AgentEvents = z.infer<typeof agentEventsSchema>

/**
 * TaskEvent
 */

export const taskEventSchema = z.discriminatedUnion("eventName", [
	// Task Provider Lifecycle
	z.object({
		eventName: z.literal(AgentEventName.TaskCreated),
		payload: agentEventsSchema.shape[AgentEventName.TaskCreated],
		taskId: z.number().optional(),
	}),

	// Task Lifecycle
	z.object({
		eventName: z.literal(AgentEventName.TaskStarted),
		payload: agentEventsSchema.shape[AgentEventName.TaskStarted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskCompleted),
		payload: agentEventsSchema.shape[AgentEventName.TaskCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskAborted),
		payload: agentEventsSchema.shape[AgentEventName.TaskAborted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskFocused),
		payload: agentEventsSchema.shape[AgentEventName.TaskFocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskUnfocused),
		payload: agentEventsSchema.shape[AgentEventName.TaskUnfocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskActive),
		payload: agentEventsSchema.shape[AgentEventName.TaskActive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskInteractive),
		payload: agentEventsSchema.shape[AgentEventName.TaskInteractive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskResumable),
		payload: agentEventsSchema.shape[AgentEventName.TaskResumable],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskIdle),
		payload: agentEventsSchema.shape[AgentEventName.TaskIdle],
		taskId: z.number().optional(),
	}),

	// Subtask Lifecycle
	z.object({
		eventName: z.literal(AgentEventName.TaskPaused),
		payload: agentEventsSchema.shape[AgentEventName.TaskPaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskUnpaused),
		payload: agentEventsSchema.shape[AgentEventName.TaskUnpaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskSpawned),
		payload: agentEventsSchema.shape[AgentEventName.TaskSpawned],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskDelegated),
		payload: agentEventsSchema.shape[AgentEventName.TaskDelegated],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskDelegationCompleted),
		payload: agentEventsSchema.shape[AgentEventName.TaskDelegationCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskDelegationResumed),
		payload: agentEventsSchema.shape[AgentEventName.TaskDelegationResumed],
		taskId: z.number().optional(),
	}),

	// Task Execution
	z.object({
		eventName: z.literal(AgentEventName.Message),
		payload: agentEventsSchema.shape[AgentEventName.Message],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskModeSwitched),
		payload: agentEventsSchema.shape[AgentEventName.TaskModeSwitched],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskAskResponded),
		payload: agentEventsSchema.shape[AgentEventName.TaskAskResponded],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.QueuedMessagesUpdated),
		payload: agentEventsSchema.shape[AgentEventName.QueuedMessagesUpdated],
		taskId: z.number().optional(),
	}),

	// Task Analytics
	z.object({
		eventName: z.literal(AgentEventName.TaskToolFailed),
		payload: agentEventsSchema.shape[AgentEventName.TaskToolFailed],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.TaskTokenUsageUpdated),
		payload: agentEventsSchema.shape[AgentEventName.TaskTokenUsageUpdated],
		taskId: z.number().optional(),
	}),

	// Query Responses
	z.object({
		eventName: z.literal(AgentEventName.CommandsResponse),
		payload: agentEventsSchema.shape[AgentEventName.CommandsResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.ModesResponse),
		payload: agentEventsSchema.shape[AgentEventName.ModesResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AgentEventName.ModelsResponse),
		payload: agentEventsSchema.shape[AgentEventName.ModelsResponse],
		taskId: z.number().optional(),
	}),
])

export type TaskEvent = z.infer<typeof taskEventSchema>
