import { render, screen } from "@/utils/test-utils"

import { InProgressRow } from "../InProgressRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../../ProgressIndicator", () => ({
	ProgressIndicator: () => <div data-testid="progress" />,
}))

describe("InProgressRow", () => {
	it("shows the condensation in-progress label for condense_context", () => {
		render(<InProgressRow eventType="condense_context" />)
		expect(screen.getByTestId("progress")).toBeInTheDocument()
		expect(screen.getByText("chat:contextManagement.condensation.inProgress")).toBeInTheDocument()
	})

	it("shows the truncation in-progress label for sliding_window_truncation", () => {
		render(<InProgressRow eventType="sliding_window_truncation" />)
		expect(screen.getByText("chat:contextManagement.truncation.inProgress")).toBeInTheDocument()
	})
})
