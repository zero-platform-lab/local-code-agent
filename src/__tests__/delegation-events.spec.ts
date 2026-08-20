// npx vitest run __tests__/delegation-events.spec.ts

import { AgentEventName, agentEventsSchema, taskEventSchema } from "@openai-agent/types"

describe("delegation event schemas", () => {
	test("agentEventsSchema validates tuples", () => {
		expect(() => (agentEventsSchema.shape as any)[AgentEventName.TaskDelegated].parse(["p", "c"])).not.toThrow()
		expect(() =>
			(agentEventsSchema.shape as any)[AgentEventName.TaskDelegationCompleted].parse(["p", "c", "s"]),
		).not.toThrow()
		expect(() =>
			(agentEventsSchema.shape as any)[AgentEventName.TaskDelegationResumed].parse(["p", "c"]),
		).not.toThrow()

		// invalid shapes
		expect(() => (agentEventsSchema.shape as any)[AgentEventName.TaskDelegated].parse(["p"])).toThrow()
		expect(() =>
			(agentEventsSchema.shape as any)[AgentEventName.TaskDelegationCompleted].parse(["p", "c"]),
		).toThrow()
		expect(() => (agentEventsSchema.shape as any)[AgentEventName.TaskDelegationResumed].parse(["p"])).toThrow()
	})

	test("taskEventSchema discriminated union includes delegation events", () => {
		expect(() =>
			taskEventSchema.parse({
				eventName: AgentEventName.TaskDelegated,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: AgentEventName.TaskDelegationCompleted,
				payload: ["p", "c", "s"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: AgentEventName.TaskDelegationResumed,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()
	})
})
