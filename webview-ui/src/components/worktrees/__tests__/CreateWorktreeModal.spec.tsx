import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { CreateWorktreeModal } from "../CreateWorktreeModal"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${Object.values(options).join("/")}` : key,
	}),
}))

vi.mock("@/components/ui/searchable-select", () => ({
	SearchableSelect: ({ value, onValueChange, options }: any) => (
		<select data-testid="base-branch" value={value} onChange={(e) => onValueChange(e.target.value)}>
			{options.map((option: any) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}))

const send = (message: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }))
	})
}

const sendDefaults = () =>
	send({ type: "worktreeDefaults", suggestedBranch: "worktree/feature", suggestedPath: "/repo/../feature" })

const sendBranches = (currentBranch = "main") =>
	send({ type: "branchList", currentBranch, localBranches: ["main", "dev"], remoteBranches: ["origin/main"] })

const renderModal = (props: Partial<React.ComponentProps<typeof CreateWorktreeModal>> = {}) =>
	render(<CreateWorktreeModal open onClose={vi.fn()} {...props} />)

describe("CreateWorktreeModal — filling the form", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("asks the extension for everything it needs when it opens", () => {
		renderModal()

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getWorktreeDefaults" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getAvailableBranches" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getWorktreeIncludeStatus" })
	})

	it("asks for nothing while it is closed", () => {
		render(<CreateWorktreeModal open={false} onClose={vi.fn()} />)

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("fills the form with the suggested branch and path", () => {
		renderModal()

		sendDefaults()

		expect(screen.getByDisplayValue("worktree/feature")).toBeInTheDocument()
		expect(screen.getByDisplayValue("/repo/../feature")).toBeInTheDocument()
	})

	it("waits for the branch list before offering a base branch", () => {
		renderModal()

		expect(screen.getByText("worktrees:loadingBranches")).toBeInTheDocument()

		sendBranches()

		expect(screen.getByTestId("base-branch")).toHaveValue("main")
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
			"main",
			"dev",
			"origin/main",
		])
	})

	it("falls back to main when the repository reports no current branch", () => {
		renderModal()

		send({ type: "branchList", currentBranch: "", localBranches: ["main"], remoteBranches: [] })

		expect(screen.getByTestId("base-branch")).toHaveValue("main")
	})

	it("warns when the repository has no include file", () => {
		renderModal()

		send({ type: "worktreeIncludeStatus", worktreeIncludeStatus: { exists: false } })

		expect(screen.getByText("worktrees:noIncludeFileWarning")).toBeInTheDocument()
	})

	it("stays quiet when the repository has an include file", () => {
		renderModal()

		send({ type: "worktreeIncludeStatus", worktreeIncludeStatus: { exists: true } })

		expect(screen.queryByText("worktrees:noIncludeFileWarning")).not.toBeInTheDocument()
	})

	it("takes the path the user picked in the file browser", () => {
		renderModal()

		fireEvent.click(document.querySelector(".lucide-folder-search")!)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "browseForWorktreePath" })

		send({ type: "folderSelected", path: "/picked/path" })

		expect(screen.getByDisplayValue("/picked/path")).toBeInTheDocument()
	})

	it("keeps the current path when the browser was cancelled", () => {
		renderModal()
		sendDefaults()

		send({ type: "folderSelected" })

		expect(screen.getByDisplayValue("/repo/../feature")).toBeInTheDocument()
	})

	it("ignores messages meant for something else", () => {
		renderModal()
		sendDefaults()

		send({ type: "somethingElse", suggestedBranch: "nope" })

		expect(screen.getByDisplayValue("worktree/feature")).toBeInTheDocument()
	})
})

describe("CreateWorktreeModal — creating", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const fillIn = () => {
		sendDefaults()
		sendBranches()
	}

	it("cannot be submitted until every field has something in it", () => {
		renderModal()
		const create = screen.getByRole("button", { name: "worktrees:create" })

		expect(create).toBeDisabled()

		fillIn()

		expect(create).toBeEnabled()
	})

	it("stays disabled while a field holds only spaces", () => {
		renderModal()
		fillIn()

		fireEvent.change(screen.getByDisplayValue("worktree/feature"), { target: { value: "   " } })

		expect(screen.getByRole("button", { name: "worktrees:create" })).toBeDisabled()
	})

	it("sends what the user typed", () => {
		renderModal()
		fillIn()
		fireEvent.change(screen.getByDisplayValue("worktree/feature"), { target: { value: "worktree/mine" } })
		fireEvent.change(screen.getByDisplayValue("/repo/../feature"), { target: { value: "/my/path" } })
		fireEvent.change(screen.getByTestId("base-branch"), { target: { value: "dev" } })

		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "createWorktree",
			worktreePath: "/my/path",
			worktreeBranch: "worktree/mine",
			worktreeBaseBranch: "dev",
			worktreeCreateNewBranch: true,
		})
	})

	it("shows that it is working and blocks a second attempt", () => {
		renderModal()
		fillIn()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		expect(screen.getByText("worktrees:creating")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "worktrees:cancel" })).toBeDisabled()
	})

	it("reports how far the copying has got", () => {
		renderModal()
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeCopyProgress", copyProgressBytesCopied: 2048, copyProgressItemName: "node_modules" })

		expect(screen.getByText("worktrees:copyingProgress:node_modules/2.05 kB")).toBeInTheDocument()
	})

	it("copes with a progress message that carries no numbers", () => {
		renderModal()
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeCopyProgress" })

		expect(screen.getByText("worktrees:copyingProgress:/0 B")).toBeInTheDocument()
	})

	it("closes and reports success once the worktree exists", () => {
		const onClose = vi.fn()
		const onSuccess = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} onSuccess={onSuccess} />)
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeResult", success: true })

		expect(onSuccess).toHaveBeenCalled()
		expect(onClose).toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchWorktree" }))
	})

	it("opens the new worktree in a window when asked to", () => {
		render(<CreateWorktreeModal open onClose={vi.fn()} openAfterCreate />)
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeResult", success: true })

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchWorktree",
			worktreePath: "/repo/../feature",
			worktreeNewWindow: true,
		})
	})

	it("closes even when nobody is listening for success", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeResult", success: true })

		expect(onClose).toHaveBeenCalled()
	})

	it("keeps the form open and shows why creating failed", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeResult", success: false, text: "branch already exists" })

		expect(screen.getByText("branch already exists")).toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "worktrees:create" })).toBeEnabled()
	})

	it("says something even when the failure has no reason", () => {
		renderModal()
		fillIn()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))

		send({ type: "worktreeResult", success: false })

		expect(screen.getByText("Unknown error")).toBeInTheDocument()
	})

	it("closes from the cancel button", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)

		fireEvent.click(screen.getByRole("button", { name: "worktrees:cancel" }))

		expect(onClose).toHaveBeenCalled()
	})

	it("closes when the dialog itself is dismissed", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)

		fireEvent.keyDown(document.body, { key: "Escape" })

		expect(onClose).toHaveBeenCalled()
	})
})
