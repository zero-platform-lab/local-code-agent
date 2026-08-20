import { render, screen } from "@/utils/test-utils"

import { CondensationErrorRow } from "../CondensationErrorRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

describe("CondensationErrorRow", () => {
	it("renders the error header without detail text when errorText is absent", () => {
		render(<CondensationErrorRow />)
		expect(screen.getByText("chat:contextManagement.condensation.errorHeader")).toBeInTheDocument()
		// 追加のエラー詳細は表示されない（ヘッダのみ）
		expect(screen.queryByText("boom")).not.toBeInTheDocument()
	})

	it("renders the provided error detail text", () => {
		render(<CondensationErrorRow errorText="boom" />)
		expect(screen.getByText("boom")).toBeInTheDocument()
	})
})
