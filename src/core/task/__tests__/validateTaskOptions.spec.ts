// npx vitest run core/task/__tests__/validateTaskOptions.spec.ts

import { MAX_CHECKPOINT_TIMEOUT_SECONDS, MIN_CHECKPOINT_TIMEOUT_SECONDS } from "@openai-agent/types"

import { validateTaskOptions } from "../validateTaskOptions"

const validInput = {
	startTask: true,
	task: "hello",
	images: undefined,
	historyItem: undefined,
	checkpointTimeout: 30,
}

describe("validateTaskOptions", () => {
	it("passes when startTask + task are provided", () => {
		expect(() => validateTaskOptions(validInput)).not.toThrow()
	})

	it("passes when startTask + images are provided", () => {
		expect(() =>
			validateTaskOptions({ ...validInput, task: undefined, images: ["data:image/png;base64,x"] }),
		).not.toThrow()
	})

	it("passes when startTask + historyItem are provided", () => {
		expect(() => validateTaskOptions({ ...validInput, task: undefined, historyItem: { id: "x" } })).not.toThrow()
	})

	it("passes when startTask is false even without task/images/historyItem", () => {
		expect(() => validateTaskOptions({ ...validInput, startTask: false, task: undefined })).not.toThrow()
	})

	it("throws when startTask is true and no task/images/historyItem", () => {
		expect(() => validateTaskOptions({ ...validInput, task: undefined })).toThrow(
			"Either historyItem or task/images must be provided",
		)
	})

	it("throws when checkpointTimeout is 0 (falsy guard)", () => {
		expect(() => validateTaskOptions({ ...validInput, checkpointTimeout: 0 })).toThrow(/checkpointTimeout must be/)
	})

	it("throws when checkpointTimeout exceeds MAX", () => {
		expect(() =>
			validateTaskOptions({ ...validInput, checkpointTimeout: MAX_CHECKPOINT_TIMEOUT_SECONDS + 1 }),
		).toThrow(/checkpointTimeout must be/)
	})

	it("throws when checkpointTimeout below MIN", () => {
		expect(() =>
			validateTaskOptions({ ...validInput, checkpointTimeout: MIN_CHECKPOINT_TIMEOUT_SECONDS - 1 }),
		).toThrow(/checkpointTimeout must be/)
	})

	it("accepts the boundary values", () => {
		expect(() =>
			validateTaskOptions({ ...validInput, checkpointTimeout: MIN_CHECKPOINT_TIMEOUT_SECONDS }),
		).not.toThrow()
		expect(() =>
			validateTaskOptions({ ...validInput, checkpointTimeout: MAX_CHECKPOINT_TIMEOUT_SECONDS }),
		).not.toThrow()
	})
})
