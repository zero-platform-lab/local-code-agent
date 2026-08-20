import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import { CheckpointMenu } from "../CheckpointMenu"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui/hooks", () => ({ useAgentPortal: () => document.body }))

const baseProps = {
	ts: 1234,
	commitHash: "abc123",
	checkpoint: { from: "prev123", to: "abc123" },
}

const openRestoreMenu = () => fireEvent.click(screen.getByLabelText("chat:checkpoint.menu.restore"))
const openMoreMenu = () => fireEvent.click(screen.getByLabelText("chat:checkpoint.menu.more"))

describe("CheckpointMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows the diff of this checkpoint alone", () => {
		const { container } = render(<CheckpointMenu {...baseProps} />)

		fireEvent.click(container.querySelector(".codicon-diff-single")!.closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointDiff",
			payload: { ts: 1234, previousCommitHash: "prev123", commitHash: "abc123", mode: "checkpoint" },
		})
	})

	it("restores only the files without asking twice", () => {
		render(<CheckpointMenu {...baseProps} />)
		openRestoreMenu()

		fireEvent.click(screen.getByTestId("restore-files-btn"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointRestore",
			payload: { ts: 1234, commitHash: "abc123", mode: "preview" },
		})
		expect(screen.queryByTestId("restore-files-btn")).not.toBeInTheDocument()
	})

	it("asks for confirmation before throwing away the conversation", () => {
		render(<CheckpointMenu {...baseProps} />)
		openRestoreMenu()

		fireEvent.click(screen.getByTestId("restore-files-and-task-btn"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("checkpoint-confirm-warning")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("confirm-restore-btn"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointRestore",
			payload: { ts: 1234, commitHash: "abc123", mode: "restore" },
		})
	})

	it("lets the confirmation be called off", () => {
		render(<CheckpointMenu {...baseProps} />)
		openRestoreMenu()
		fireEvent.click(screen.getByTestId("restore-files-and-task-btn"))

		fireEvent.click(screen.getByText("chat:checkpoint.menu.cancel").closest("button")!)

		expect(screen.getByTestId("restore-files-and-task-btn")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("forgets a pending confirmation when the menu is closed", () => {
		render(<CheckpointMenu {...baseProps} />)
		openRestoreMenu()
		fireEvent.click(screen.getByTestId("restore-files-and-task-btn"))

		fireEvent.keyDown(document.body, { key: "Escape" })
		openRestoreMenu()

		expect(screen.getByTestId("restore-files-and-task-btn")).toBeInTheDocument()
	})

	it("tells the caller when a menu opens and closes", () => {
		const onOpenChange = vi.fn()
		render(<CheckpointMenu {...baseProps} onOpenChange={onOpenChange} />)

		openRestoreMenu()
		expect(onOpenChange).toHaveBeenLastCalledWith(true)

		fireEvent.click(screen.getByTestId("restore-files-btn"))
		expect(onOpenChange).toHaveBeenLastCalledWith(false)
	})

	it("tells the caller about the overflow menu too", () => {
		const onOpenChange = vi.fn()
		render(<CheckpointMenu {...baseProps} onOpenChange={onOpenChange} />)

		openMoreMenu()
		expect(onOpenChange).toHaveBeenLastCalledWith(true)

		fireEvent.click(screen.getByText("chat:checkpoint.menu.viewDiffFromInit").closest("button")!)
		expect(onOpenChange).toHaveBeenLastCalledWith(false)
	})

	it("works without anyone listening for open changes", () => {
		render(<CheckpointMenu {...baseProps} />)

		expect(() => {
			openRestoreMenu()
			fireEvent.click(screen.getByTestId("restore-files-btn"))
		}).not.toThrow()
	})

	it("offers the diff since the start of the task", () => {
		render(<CheckpointMenu {...baseProps} />)
		openMoreMenu()

		fireEvent.click(screen.getByText("chat:checkpoint.menu.viewDiffFromInit").closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointDiff",
			payload: { ts: 1234, commitHash: "abc123", mode: "from-init" },
		})
		expect(screen.queryByText("chat:checkpoint.menu.viewDiffFromInit")).not.toBeInTheDocument()
	})

	it("offers the diff against the current state", () => {
		render(<CheckpointMenu {...baseProps} />)
		openMoreMenu()

		fireEvent.click(screen.getByText("chat:checkpoint.menu.viewDiffWithCurrent").closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointDiff",
			payload: { ts: 1234, commitHash: "abc123", mode: "to-current" },
		})
	})

	it("jumps to the latest checkpoint", () => {
		const onJumpToPreviousCheckpoint = vi.fn()
		render(<CheckpointMenu {...baseProps} onJumpToPreviousCheckpoint={onJumpToPreviousCheckpoint} />)

		fireEvent.click(screen.getByTestId("jump-previous-checkpoint-btn"))

		expect(onJumpToPreviousCheckpoint).toHaveBeenCalled()
	})

	it("diffs against nothing in particular when there is no previous checkpoint", () => {
		const { container } = render(<CheckpointMenu {...baseProps} checkpoint={{ to: "abc123" } as never} />)

		fireEvent.click(container.querySelector(".codicon-diff-single")!.closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "checkpointDiff",
			payload: { ts: 1234, previousCommitHash: undefined, commitHash: "abc123", mode: "checkpoint" },
		})
	})
})
