import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { CreateSlashCommandDialog } from "../CreateSlashCommandDialog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
	DialogContent: ({ children }: any) => <div>{children}</div>,
	DialogDescription: ({ children }: any) => <div>{children}</div>,
	DialogFooter: ({ children }: any) => <div>{children}</div>,
	DialogHeader: ({ children }: any) => <div>{children}</div>,
	DialogTitle: ({ children }: any) => <h2>{children}</h2>,
	Button: ({ children, onClick, disabled, variant }: any) => (
		<button onClick={onClick} disabled={disabled} data-variant={variant}>
			{children}
		</button>
	),
	Input: (props: any) => <input {...props} />,
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="source-select" data-value={value}>
			<button data-testid="pick-global" onClick={() => onValueChange("global")} />
			<button data-testid="pick-project" onClick={() => onValueChange("project")} />
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-testid={`option-${value}`}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: () => <span />,
}))

const renderDialog = (props: Partial<React.ComponentProps<typeof CreateSlashCommandDialog>> = {}) =>
	render(<CreateSlashCommandDialog open onOpenChange={vi.fn()} onCommandCreated={vi.fn()} hasWorkspace {...props} />)

const nameInput = () => screen.getByRole("textbox")
const createButton = () => screen.getByText("settings:slashCommands.createDialog.create").closest("button")!

describe("CreateSlashCommandDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows nothing while it is closed", () => {
		renderDialog({ open: false })

		expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
	})

	it("starts with the workspace as the destination when there is one", () => {
		renderDialog()

		expect(screen.getByTestId("source-select")).toHaveAttribute("data-value", "project")
		expect(screen.getByTestId("option-project")).toBeInTheDocument()
	})

	it("can only write globally without a workspace", () => {
		renderDialog({ hasWorkspace: false })

		expect(screen.getByTestId("source-select")).toHaveAttribute("data-value", "global")
		expect(screen.queryByTestId("option-project")).not.toBeInTheDocument()
	})

	it("keeps the name to characters a command file can carry", () => {
		renderDialog()

		fireEvent.change(nameInput(), { target: { value: "My Command!@#_-2" } })

		expect(nameInput()).toHaveValue("mycommand_-2")
	})

	it("cannot be submitted with an empty name", () => {
		renderDialog()

		expect(createButton()).toBeDisabled()
	})

	it("creates the command file, adding the extension", () => {
		const onCommandCreated = vi.fn()
		const onOpenChange = vi.fn()
		renderDialog({ onCommandCreated, onOpenChange })

		fireEvent.change(nameInput(), { target: { value: "deploy" } })
		fireEvent.click(createButton())

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "createCommand",
			text: "deploy.md",
			values: { source: "project" },
		})
		expect(onCommandCreated).toHaveBeenCalled()
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("drops a typed extension rather than building a double one", () => {
		renderDialog()

		fireEvent.change(nameInput(), { target: { value: "deploy.md" } })
		fireEvent.click(createButton())

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "deploymd.md" }))
	})

	it("writes where the user chose to", () => {
		renderDialog()

		fireEvent.change(nameInput(), { target: { value: "deploy" } })
		fireEvent.click(screen.getByTestId("pick-global"))
		fireEvent.click(createButton())

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ values: { source: "global" } }))
	})

	it("refuses a name that is longer than a file name may be", () => {
		renderDialog()

		fireEvent.change(nameInput(), { target: { value: "a".repeat(65) } })
		fireEvent.click(createButton())

		expect(screen.getByText("settings:slashCommands.validation.nameTooLong")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("refuses a name made only of spaces", () => {
		renderDialog()

		// The input filter drops the spaces, so the value has to be forced past it.
		fireEvent.change(nameInput(), { target: { value: "x" } })
		fireEvent.change(nameInput(), { target: { value: " " } })
		fireEvent.click(createButton())

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("clears the error as soon as the name is edited again", () => {
		renderDialog()

		fireEvent.change(nameInput(), { target: { value: "a".repeat(65) } })
		fireEvent.click(createButton())
		expect(screen.getByText("settings:slashCommands.validation.nameTooLong")).toBeInTheDocument()

		fireEvent.change(nameInput(), { target: { value: "deploy" } })

		expect(screen.queryByText("settings:slashCommands.validation.nameTooLong")).not.toBeInTheDocument()
	})

	it("forgets what was typed when it is cancelled", () => {
		const onOpenChange = vi.fn()
		const { rerender } = renderDialog({ onOpenChange })
		fireEvent.change(nameInput(), { target: { value: "deploy" } })

		fireEvent.click(screen.getByText("settings:slashCommands.createDialog.cancel").closest("button")!)

		expect(onOpenChange).toHaveBeenCalledWith(false)
		rerender(<CreateSlashCommandDialog open onOpenChange={onOpenChange} onCommandCreated={vi.fn()} hasWorkspace />)
		expect(nameInput()).toHaveValue("")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
	it("goes back to the global destination when cancelled without a workspace", () => {
		const onOpenChange = vi.fn()
		const { rerender } = renderDialog({ hasWorkspace: false, onOpenChange })
		fireEvent.change(nameInput(), { target: { value: "deploy" } })

		fireEvent.click(screen.getByText("settings:slashCommands.createDialog.cancel").closest("button")!)
		rerender(
			<CreateSlashCommandDialog
				open
				onOpenChange={onOpenChange}
				onCommandCreated={vi.fn()}
				hasWorkspace={false}
			/>,
		)

		expect(screen.getByTestId("source-select")).toHaveAttribute("data-value", "global")
		expect(nameInput()).toHaveValue("")
	})
})
