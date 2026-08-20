import { render, screen, fireEvent } from "@/utils/test-utils"

import {
	MessageModificationConfirmationDialog,
	EditMessageDialog,
	DeleteMessageDialog,
} from "../MessageModificationConfirmationDialog"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("MessageModificationConfirmationDialog", () => {
	it("does not render dialog content while closed", () => {
		render(
			<MessageModificationConfirmationDialog
				open={false}
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
				type="edit"
			/>,
		)
		expect(screen.queryByText("common:confirmation.editMessage")).not.toBeInTheDocument()
	})

	it("shows the edit copy when type is 'edit'", () => {
		render(<MessageModificationConfirmationDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} type="edit" />)
		expect(screen.getByText("common:confirmation.editMessage")).toBeInTheDocument()
		expect(screen.getByText("common:confirmation.editWarning")).toBeInTheDocument()
	})

	it("shows the delete copy when type is 'delete'", () => {
		render(<MessageModificationConfirmationDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} type="delete" />)
		expect(screen.getByText("common:confirmation.deleteMessage")).toBeInTheDocument()
		expect(screen.getByText("common:confirmation.deleteWarning")).toBeInTheDocument()
	})

	it("invokes onConfirm when the proceed action is clicked", () => {
		const onConfirm = vi.fn()
		render(<MessageModificationConfirmationDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} type="edit" />)
		fireEvent.click(screen.getByText("common:confirmation.proceed"))
		expect(onConfirm).toHaveBeenCalledTimes(1)
	})

	it("EditMessageDialog forwards type='edit'", () => {
		render(<EditMessageDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
		expect(screen.getByText("common:confirmation.editMessage")).toBeInTheDocument()
	})

	it("DeleteMessageDialog forwards type='delete'", () => {
		render(<DeleteMessageDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
		expect(screen.getByText("common:confirmation.deleteMessage")).toBeInTheDocument()
	})
})
