import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Provide a small, controlled experiment registry.
vi.mock("@agent/experiments", () => ({
	EXPERIMENT_IDS: { FOO: "foo", BAR: "bar" },
	experimentConfigsMap: {
		FOO: { enabled: false },
		BAR: { enabled: false },
		// This key is intentionally absent from EXPERIMENT_IDS to exercise the filter.
		LEGACY: { enabled: false },
	},
}))

vi.mock("../ExperimentalFeature", () => ({
	ExperimentalFeature: ({ experimentKey, enabled, onChange }: any) => (
		<button
			data-testid={`feature-${experimentKey}`}
			data-enabled={String(enabled)}
			onClick={() => onChange(!enabled)}>
			{experimentKey}
		</button>
	),
}))

describe("ExperimentalSettings", () => {
	it("renders only experiments present in EXPERIMENT_IDS", () => {
		render(<ExperimentalSettings experiments={{} as any} setExperimentEnabled={vi.fn()} />)
		expect(screen.getByTestId("feature-FOO")).toBeInTheDocument()
		expect(screen.getByTestId("feature-BAR")).toBeInTheDocument()
		expect(screen.queryByTestId("feature-LEGACY")).not.toBeInTheDocument()
	})

	it("reflects the enabled state from the experiments map (and defaults to false)", () => {
		render(<ExperimentalSettings experiments={{ foo: true } as any} setExperimentEnabled={vi.fn()} />)
		expect(screen.getByTestId("feature-FOO")).toHaveAttribute("data-enabled", "true")
		// bar not present -> ?? false
		expect(screen.getByTestId("feature-BAR")).toHaveAttribute("data-enabled", "false")
	})

	it("calls setExperimentEnabled with the mapped id and the new value", () => {
		const setExperimentEnabled = vi.fn()
		render(<ExperimentalSettings experiments={{} as any} setExperimentEnabled={setExperimentEnabled} />)
		fireEvent.click(screen.getByTestId("feature-FOO"))
		expect(setExperimentEnabled).toHaveBeenCalledWith("foo", true)
	})
})
