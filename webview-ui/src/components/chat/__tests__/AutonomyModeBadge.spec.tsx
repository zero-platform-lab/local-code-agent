import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { AutonomyModeBadge } from "../AutonomyModeBadge"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

// Controlled by each test.
let mockAutonomyMode: string | undefined = "manual"
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ autonomyMode: mockAutonomyMode }),
}))

describe("AutonomyModeBadge", () => {
	beforeEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("renders the current mode label", () => {
		mockAutonomyMode = "auto"
		render(<AutonomyModeBadge />)
		expect(screen.getByTestId("autonomy-mode-badge")).toHaveTextContent("chat:autonomy.auto")
	})

	it("cycles manual -> autoEdit on click", () => {
		mockAutonomyMode = "manual"
		render(<AutonomyModeBadge />)
		fireEvent.click(screen.getByTestId("autonomy-mode-badge"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "setAutonomyMode", autonomyMode: "autoEdit" })
	})

	it("cycles auto -> plan on click", () => {
		mockAutonomyMode = "auto"
		render(<AutonomyModeBadge />)
		fireEvent.click(screen.getByTestId("autonomy-mode-badge"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "setAutonomyMode", autonomyMode: "plan" })
	})

	it("wraps plan -> manual on click", () => {
		mockAutonomyMode = "plan"
		render(<AutonomyModeBadge />)
		fireEvent.click(screen.getByTestId("autonomy-mode-badge"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "setAutonomyMode", autonomyMode: "manual" })
	})

	it("falls back to manual when mode is undefined", () => {
		mockAutonomyMode = undefined
		render(<AutonomyModeBadge />)
		expect(screen.getByTestId("autonomy-mode-badge")).toHaveTextContent("chat:autonomy.manual")
	})
})
