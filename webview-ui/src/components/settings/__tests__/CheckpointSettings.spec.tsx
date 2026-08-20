import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS } from "@openai-agent/types"

import { CheckpointSettings } from "../CheckpointSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: any) => <span>{children}</span>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input
				type="checkbox"
				data-testid="enable-checkpoints-checkbox"
				checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
	VSCodeLink: ({ children }: any) => <a>{children}</a>,
}))

vi.mock("@/components/ui", () => ({
	Slider: ({ onValueChange, "data-testid": testid }: any) => (
		<button data-testid={testid} onClick={() => onValueChange([42])}>
			slider
		</button>
	),
}))

describe("CheckpointSettings", () => {
	it("hides the timeout slider when checkpoints are disabled", () => {
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("checkpoint-timeout-slider")).not.toBeInTheDocument()
	})

	it("shows the timeout slider and provided timeout when enabled", () => {
		render(<CheckpointSettings enableCheckpoints={true} checkpointTimeout={30} setCachedStateField={vi.fn()} />)
		expect(screen.getByTestId("checkpoint-timeout-slider")).toBeInTheDocument()
		expect(screen.getByText("30")).toBeInTheDocument()
	})

	it("falls back to the default timeout when unset", () => {
		render(<CheckpointSettings enableCheckpoints={true} setCachedStateField={vi.fn()} />)
		expect(screen.getByText(String(DEFAULT_CHECKPOINT_TIMEOUT_SECONDS))).toBeInTheDocument()
	})

	it("updates only enableCheckpoints when the checkbox is toggled", () => {
		const setCachedStateField = vi.fn()
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={setCachedStateField} />)
		fireEvent.click(screen.getByTestId("enable-checkpoints-checkbox"))
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(setCachedStateField).toHaveBeenCalledWith("enableCheckpoints", true)
	})

	it("updates checkpointTimeout from the slider", () => {
		const setCachedStateField = vi.fn()
		render(
			<CheckpointSettings
				enableCheckpoints={true}
				checkpointTimeout={30}
				setCachedStateField={setCachedStateField}
			/>,
		)
		fireEvent.click(screen.getByTestId("checkpoint-timeout-slider"))
		expect(setCachedStateField).toHaveBeenCalledWith("checkpointTimeout", 42)
	})
})
