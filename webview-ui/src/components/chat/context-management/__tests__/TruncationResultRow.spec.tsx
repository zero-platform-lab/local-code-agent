import { render, screen, fireEvent } from "@/utils/test-utils"

import { TruncationResultRow } from "../TruncationResultRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts && "count" in opts ? `${key}:${opts.count}` : key),
	}),
}))

const fullData = {
	messagesRemoved: 3,
	prevContextTokens: 2000,
	newContextTokens: 800,
} as any

describe("TruncationResultRow", () => {
	it("renders the title and token reduction collapsed by default", () => {
		render(<TruncationResultRow data={fullData} />)
		expect(screen.getByText("chat:contextManagement.truncation.title")).toBeInTheDocument()
		expect(screen.getByText(/2,000 → 800/)).toBeInTheDocument()
		// 折りたたみ時は詳細（messagesRemoved）は非表示
		expect(screen.queryByText("chat:contextManagement.truncation.messagesRemoved:3")).not.toBeInTheDocument()
	})

	it("shows the removed-messages detail after expanding, then hides on collapse", () => {
		const { container } = render(<TruncationResultRow data={fullData} />)
		const header = container.querySelector(".cursor-pointer") as HTMLElement

		fireEvent.click(header)
		expect(screen.getByText("chat:contextManagement.truncation.messagesRemoved:3")).toBeInTheDocument()
		expect(container.querySelector(".codicon-chevron-up")).toBeInTheDocument()

		fireEvent.click(header)
		expect(screen.queryByText("chat:contextManagement.truncation.messagesRemoved:3")).not.toBeInTheDocument()
	})

	it("defaults null token/removed values to 0", () => {
		const { container } = render(
			<TruncationResultRow
				data={{ messagesRemoved: null, prevContextTokens: null, newContextTokens: null } as any}
			/>,
		)
		expect(screen.getByText(/0 → 0/)).toBeInTheDocument()
		fireEvent.click(container.querySelector(".cursor-pointer") as HTMLElement)
		expect(screen.getByText("chat:contextManagement.truncation.messagesRemoved:0")).toBeInTheDocument()
	})
})
