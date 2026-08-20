import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import { DeleteButton } from "../DeleteButton"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("DeleteButton", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls onDelete when clicked", () => {
		const onDelete = vi.fn()
		render(<DeleteButton itemId="test-id" onDelete={onDelete} />)

		const deleteButton = screen.getByRole("button")
		fireEvent.click(deleteButton)

		expect(onDelete).toHaveBeenCalledWith("test-id")
	})
	it("deletes without confirmation on a shift-click", () => {
		const onDelete = vi.fn()
		render(<DeleteButton itemId="test-id" onDelete={onDelete} />)

		fireEvent.click(screen.getByRole("button"), { shiftKey: true })

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteTaskWithId", text: "test-id" })
		expect(onDelete).not.toHaveBeenCalled()
	})

	it("does nothing when there is nothing to confirm with", () => {
		render(<DeleteButton itemId="test-id" />)

		fireEvent.click(screen.getByRole("button"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps the click from opening the task behind it", () => {
		const onDelete = vi.fn()
		const onRowClick = vi.fn()
		render(
			<div onClick={onRowClick}>
				<DeleteButton itemId="test-id" onDelete={onDelete} />
			</div>,
		)

		fireEvent.click(screen.getByRole("button"))

		expect(onDelete).toHaveBeenCalled()
		expect(onRowClick).not.toHaveBeenCalled()
	})
})
