import { render, screen, fireEvent } from "@/utils/test-utils"

import { CommandExecutionError } from "../CommandExecutionError"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	// components.settingsLink をそのまま描画してクリック可能にする
	Trans: ({ components }: { components?: Record<string, React.ReactNode> }) => <>{components?.settingsLink}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<a href="#" onClick={onClick} data-testid="settings-link">
			{children}
		</a>
	),
}))

vi.mock("@src/utils/docLinks", () => ({
	buildDocLink: (path: string, campaign: string) => `https://docs/${path}?c=${campaign}`,
}))

describe("CommandExecutionError", () => {
	it("renders the shell-integration title and troubleshooting link", () => {
		render(<CommandExecutionError />)
		expect(screen.getByText("chat:shellIntegration.title")).toBeInTheDocument()
		const trouble = screen.getByText("chat:shellIntegration.troubleshooting")
		expect(trouble).toHaveAttribute("href", "https://docs/troubleshooting/shell-integration/?c=error_tooltip")
	})

	it("posts a settings navigation message when the settings link is clicked", () => {
		const postSpy = vi.spyOn(window, "postMessage")
		render(<CommandExecutionError />)

		fireEvent.click(screen.getByTestId("settings-link"))

		expect(postSpy).toHaveBeenCalledWith(
			{ type: "action", action: "settingsButtonClicked", values: { section: "terminal" } },
			"*",
		)
		postSpy.mockRestore()
	})
})
