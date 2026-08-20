// npx vitest run src/shared/__tests__/experiments.spec.ts

import type { ExperimentId } from "@openai-agent/types"

import { EXPERIMENT_IDS, experimentConfigsMap, experiments as Experiments } from "../experiments"

describe("experiments", () => {
	describe("PREVENT_FOCUS_DISRUPTION", () => {
		it("is configured correctly", () => {
			expect(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION).toBe("preventFocusDisruption")
			expect(experimentConfigsMap.PREVENT_FOCUS_DISRUPTION).toMatchObject({
				enabled: false,
			})
		})
	})

	describe("get", () => {
		it("returns the config for a known experiment key", () => {
			expect(Experiments.get("PREVENT_FOCUS_DISRUPTION")).toEqual({ enabled: false })
			expect(Experiments.get("RUN_SLASH_COMMAND")).toEqual({ enabled: false })
		})
	})

	describe("isEnabled", () => {
		it("returns false when experiment is not enabled", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: false,
				runSlashCommand: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)
		})

		it("returns true when experiment is enabled", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: true,
				runSlashCommand: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)
		})

		it("returns false when experiment is not present", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: false,
				runSlashCommand: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)
		})
	})
})
