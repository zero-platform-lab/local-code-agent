import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { Worktree } from "@openai-agent/types"

import { vscode } from "@/utils/vscode"

import { WorktreesView } from "../WorktreesView"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const extensionState = vi.hoisted(() => ({
	showWorktreesInHomeScreen: false,
	setShowWorktreesInHomeScreen: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))

vi.mock("../CreateWorktreeModal", () => ({
	CreateWorktreeModal: ({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) => (
		<div data-testid="create-modal">
			<button data-testid="create-close" onClick={onClose} />
			<button data-testid="create-success" onClick={onSuccess} />
		</div>
	),
}))

vi.mock("../DeleteWorktreeModal", () => ({
	DeleteWorktreeModal: ({
		worktree,
		onClose,
		onSuccess,
	}: {
		worktree: Worktree
		onClose: () => void
		onSuccess: () => void
	}) => (
		<div data-testid="delete-modal" data-path={worktree.path}>
			<button data-testid="delete-close" onClick={onClose} />
			<button data-testid="delete-success" onClick={onSuccess} />
		</div>
	),
}))

const worktree = (overrides: Partial<Worktree> = {}): Worktree =>
	({
		path: "/repo",
		branch: "main",
		commitHash: "abc",
		isCurrent: false,
		isBare: false,
		isDetached: false,
		isLocked: false,
		...overrides,
	}) as Worktree

const sendList = (overrides: Record<string, unknown> = {}) => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "worktreeList",
					worktrees: [
						worktree({ path: "/repo", isCurrent: true }),
						worktree({ path: "/wt", branch: "feature" }),
					],
					isGitRepo: true,
					isMultiRoot: false,
					isSubfolder: false,
					gitRootPath: "/repo",
					...overrides,
				},
			}),
		)
	})
}

const send = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

describe("WorktreesView — what it can show", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.showWorktreesInHomeScreen = false
	})

	it("asks for the list and the include status as soon as it opens", () => {
		render(<WorktreesView />)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getWorktreeIncludeStatus" })
	})

	it("keeps asking for the list while it is open", () => {
		vi.useFakeTimers()
		render(<WorktreesView />)
		const before = vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "listWorktrees").length

		act(() => {
			vi.advanceTimersByTime(3000)
		})

		const after = vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "listWorktrees").length
		expect(after).toBe(before + 1)
		vi.useRealTimers()
	})

	it("shows a spinner until the first list arrives", () => {
		const { container } = render(<WorktreesView />)

		expect(container.querySelector(".codicon-loading")).toBeInTheDocument()

		sendList()

		expect(screen.getByText("feature")).toBeInTheDocument()
	})

	it("says when the folder is not a repository", () => {
		render(<WorktreesView />)

		sendList({ isGitRepo: false })

		expect(screen.getByText("worktrees:notGitRepo")).toBeInTheDocument()
	})

	it("says when the workspace has several roots", () => {
		render(<WorktreesView />)

		sendList({ isMultiRoot: true })

		expect(screen.getByText("worktrees:multiRootNotSupported")).toBeInTheDocument()
	})

	it("says when the workspace is a subfolder, and where the repository root is", () => {
		render(<WorktreesView />)

		sendList({ isSubfolder: true, gitRootPath: "/the/root" })

		expect(screen.getByText("worktrees:subfolderNotSupported")).toBeInTheDocument()
		expect(screen.getByText("/the/root")).toBeInTheDocument()
	})

	it("shows what went wrong instead of an empty list", () => {
		render(<WorktreesView />)

		sendList({ error: "git not found", worktrees: [] })

		expect(screen.getByText("git not found")).toBeInTheDocument()
	})

	it("copes with a list message that carries no worktrees", () => {
		render(<WorktreesView />)

		sendList({ worktrees: undefined })

		expect(screen.queryByText("feature")).not.toBeInTheDocument()
	})

	it("labels a detached worktree and one without a branch", () => {
		render(<WorktreesView />)

		sendList({
			worktrees: [worktree({ path: "/a", branch: "", isDetached: true }), worktree({ path: "/b", branch: "" })],
		})

		expect(screen.getByText("worktrees:detachedHead")).toBeInTheDocument()
		expect(screen.getByText("worktrees:noBranch")).toBeInTheDocument()
	})

	it("marks the primary worktree and a locked one", () => {
		const { container } = render(<WorktreesView />)

		sendList({
			worktrees: [
				worktree({ path: "/a", isBare: true }),
				worktree({ path: "/b", isLocked: true, lockReason: "in use" }),
			],
		})

		expect(screen.getByText("worktrees:primary")).toBeInTheDocument()
		expect(container.querySelector(".lucide-lock")).toBeInTheDocument()
	})

	it("shows a locked worktree without a reason too", () => {
		const { container } = render(<WorktreesView />)

		sendList({ worktrees: [worktree({ path: "/b", isLocked: true })] })

		expect(container.querySelector(".lucide-lock")).toBeInTheDocument()
	})
})

describe("WorktreesView — acting on a worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.showWorktreesInHomeScreen = false
	})

	it("switches to another worktree when its row is clicked", () => {
		render(<WorktreesView />)
		sendList()

		fireEvent.click(screen.getByText("feature").closest("div.rounded-xl")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchWorktree",
			worktreePath: "/wt",
			worktreeNewWindow: false,
		})
	})

	it("does nothing when the current worktree's row is clicked", () => {
		render(<WorktreesView />)
		sendList()

		fireEvent.click(screen.getByText("main").closest("div.rounded-xl")!)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchWorktree" }))
	})

	it("opens another worktree in a new window without also switching in place", () => {
		const { container } = render(<WorktreesView />)
		sendList()

		const row = screen.getByText("feature").closest("div.rounded-xl")!
		fireEvent.click(row.querySelector(".lucide-square-arrow-out-up-right")!.closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchWorktree",
			worktreePath: "/wt",
			worktreeNewWindow: true,
		})
		expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "switchWorktree")).toHaveLength(1)
		expect(container).toBeTruthy()
	})

	it("offers no actions for the worktree that is already open", () => {
		render(<WorktreesView />)
		sendList()

		const row = screen.getByText("main").closest("div.rounded-xl")!
		for (const button of Array.from(row.querySelectorAll("button"))) {
			expect(button).toBeDisabled()
		}
	})

	it("cannot delete the primary worktree", () => {
		render(<WorktreesView />)
		sendList({ worktrees: [worktree({ path: "/a", isBare: true })] })

		const row = screen.getByText("main").closest("div.rounded-xl")!
		expect(row.querySelector(".lucide-trash")!.closest("button")).toBeDisabled()
	})

	it("asks before deleting and refreshes the list afterwards", () => {
		render(<WorktreesView />)
		sendList()
		const row = screen.getByText("feature").closest("div.rounded-xl")!

		fireEvent.click(row.querySelector(".lucide-trash")!.closest("button")!)
		expect(screen.getByTestId("delete-modal")).toHaveAttribute("data-path", "/wt")

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("delete-success"))

		expect(screen.queryByTestId("delete-modal")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
	})

	it("closes the delete dialog without deleting", () => {
		render(<WorktreesView />)
		sendList()

		fireEvent.click(
			screen.getByText("feature").closest("div.rounded-xl")!.querySelector(".lucide-trash")!.closest("button")!,
		)
		fireEvent.click(screen.getByTestId("delete-close"))

		expect(screen.queryByTestId("delete-modal")).not.toBeInTheDocument()
	})

	it("creates a worktree and refreshes the list afterwards", () => {
		render(<WorktreesView />)
		sendList()

		fireEvent.click(screen.getByText("worktrees:newWorktree"))
		expect(screen.getByTestId("create-modal")).toBeInTheDocument()

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("create-success"))

		expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
	})

	it("closes the create dialog without creating", () => {
		render(<WorktreesView />)
		sendList()
		fireEvent.click(screen.getByText("worktrees:newWorktree"))

		fireEvent.click(screen.getByTestId("create-close"))

		expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument()
	})

	it("remembers whether worktrees belong on the home screen", () => {
		render(<WorktreesView />)
		sendList()

		fireEvent.click(screen.getByText("worktrees:showInHomeScreen"))

		expect(extensionState.setShowWorktreesInHomeScreen).toHaveBeenCalledWith(true)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { showWorktreesInHomeScreen: true },
		})
	})

	it("turns the home screen listing off again", () => {
		extensionState.showWorktreesInHomeScreen = true
		render(<WorktreesView />)
		sendList()

		fireEvent.click(screen.getByText("worktrees:showInHomeScreen"))

		expect(extensionState.setShowWorktreesInHomeScreen).toHaveBeenCalledWith(false)
	})
})

describe("WorktreesView — the include file", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		extensionState.showWorktreesInHomeScreen = false
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("says nothing about the include file until the status arrives", () => {
		render(<WorktreesView />)
		sendList()

		expect(screen.queryByText("worktrees:noIncludeFile")).not.toBeInTheDocument()
	})

	it("confirms when the include file is already there", () => {
		render(<WorktreesView />)
		sendList()

		send({ type: "worktreeIncludeStatus", worktreeIncludeStatus: { exists: true } })

		expect(screen.getByText("worktrees:includeFileExists")).toBeInTheDocument()
	})

	it("offers to build the include file from the gitignore", () => {
		render(<WorktreesView />)
		sendList()

		send({
			type: "worktreeIncludeStatus",
			worktreeIncludeStatus: { exists: false, hasGitignore: true, gitignoreContent: "node_modules\n" },
		})

		fireEvent.click(screen.getByText("worktrees:createFromGitignore"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "createWorktreeInclude",
			worktreeIncludeContent: "node_modules\n",
		})
		expect(screen.getByText("worktrees:createFromGitignore").closest("button")).toBeDisabled()
	})

	it("drops the pending re-check when the view goes away", () => {
		vi.useFakeTimers()
		const { unmount } = render(<WorktreesView />)
		sendList()
		send({
			type: "worktreeIncludeStatus",
			worktreeIncludeStatus: { exists: false, hasGitignore: true, gitignoreContent: "node_modules\n" },
		})
		fireEvent.click(screen.getByText("worktrees:createFromGitignore"))

		unmount()
		vi.mocked(vscode.postMessage).mockClear()

		// 消えたあとにタイマーが起きても、居ないコンポーネントを触りにいかない。
		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(vscode.postMessage).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("re-checks the include status once the file has been written", () => {
		vi.useFakeTimers()
		render(<WorktreesView />)
		sendList()
		send({
			type: "worktreeIncludeStatus",
			worktreeIncludeStatus: { exists: false, hasGitignore: true, gitignoreContent: "node_modules\n" },
		})
		fireEvent.click(screen.getByText("worktrees:createFromGitignore"))
		vi.mocked(vscode.postMessage).mockClear()

		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getWorktreeIncludeStatus" })
		expect(screen.getByText("worktrees:createFromGitignore").closest("button")).toBeEnabled()
		vi.useRealTimers()
	})

	it("does nothing when there is no gitignore to build from", () => {
		render(<WorktreesView />)
		sendList()

		send({ type: "worktreeIncludeStatus", worktreeIncludeStatus: { exists: false, hasGitignore: false } })

		expect(screen.getByText("worktrees:noIncludeFile")).toBeInTheDocument()
		expect(screen.queryByText("worktrees:createFromGitignore")).not.toBeInTheDocument()
	})

	it("refreshes everything after any worktree operation", () => {
		render(<WorktreesView />)
		sendList()
		vi.mocked(vscode.postMessage).mockClear()

		send({ type: "worktreeResult", success: true })

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getWorktreeIncludeStatus" })
	})

	it("ignores messages meant for something else", () => {
		render(<WorktreesView />)
		sendList()
		vi.mocked(vscode.postMessage).mockClear()

		send({ type: "somethingElse" })

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
	it("does nothing when the gitignore turns out to be empty", () => {
		render(<WorktreesView />)
		sendList()

		send({
			type: "worktreeIncludeStatus",
			worktreeIncludeStatus: { exists: false, hasGitignore: true, gitignoreContent: "" },
		})
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByText("worktrees:createFromGitignore"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByText("worktrees:createFromGitignore").closest("button")).toBeEnabled()
	})
})
