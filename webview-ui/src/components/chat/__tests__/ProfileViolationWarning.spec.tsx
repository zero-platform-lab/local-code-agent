import { render, screen } from "@/utils/test-utils"

import { ProfileViolationWarning } from "../ProfileViolationWarning"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("ProfileViolationWarning", () => {
	it("renders the translated warning text and a warning icon", () => {
		const { container } = render(<ProfileViolationWarning />)
		expect(screen.getByText("chat:profileViolationWarning")).toBeInTheDocument()
		expect(container.querySelector(".codicon-warning")).toBeInTheDocument()
	})
})
