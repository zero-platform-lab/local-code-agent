import { render, screen, fireEvent } from "@/utils/test-utils"

import { CheckpointWarning } from "../CheckpointWarning"

vi.mock("react-i18next", () => ({
	// i18nKey と timeout を可視化して分岐を確認できるようにする
	Trans: ({ i18nKey, values, components }: any) => (
		<span data-i18n={i18nKey} data-timeout={values?.timeout}>
			{components?.settingsLink}
		</span>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<a href="#" onClick={onClick} data-testid="settings-link">
			{children}
		</a>
	),
}))

describe("CheckpointWarning", () => {
	it("uses the wait-timeout i18n key for WAIT_TIMEOUT", () => {
		const { container } = render(<CheckpointWarning warning={{ type: "WAIT_TIMEOUT", timeout: 30 }} />)
		const span = container.querySelector("[data-i18n]")
		expect(span).toHaveAttribute("data-i18n", "errors.wait_checkpoint_long_time")
		expect(span).toHaveAttribute("data-timeout", "30")
	})

	it("uses the init-timeout i18n key for INIT_TIMEOUT", () => {
		const { container } = render(<CheckpointWarning warning={{ type: "INIT_TIMEOUT", timeout: 15 }} />)
		expect(container.querySelector("[data-i18n]")).toHaveAttribute(
			"data-i18n",
			"errors.init_checkpoint_fail_long_time",
		)
	})

	it("posts a checkpoints settings navigation on settings-link click", () => {
		const postSpy = vi.spyOn(window, "postMessage")
		render(<CheckpointWarning warning={{ type: "WAIT_TIMEOUT", timeout: 30 }} />)

		fireEvent.click(screen.getByTestId("settings-link"))

		expect(postSpy).toHaveBeenCalledWith(
			{ type: "action", action: "settingsButtonClicked", values: { section: "checkpoints" } },
			"*",
		)
		postSpy.mockRestore()
	})
})
