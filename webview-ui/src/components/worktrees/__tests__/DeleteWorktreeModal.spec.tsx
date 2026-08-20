// npx vitest run src/components/worktrees/__tests__/DeleteWorktreeModal.spec.tsx
//
// DeleteWorktreeModal は `deleteWorktree` メッセージを組み立てる唯一の場所。
// ここで固定するのは次の 3 点:
//
//   1. **不変条件**: `worktreeForce` はチェックボックスを入れたときだけ true。
//      以前は locked 以外を無条件に force にしていたので、通常の削除経路が
//      `git worktree remove --force` になり、未コミットの変更と未追跡ファイルが
//      確認なしに消えていた（復元手段なし）
//   2. 強制削除のチェックボックスは locked かどうかに関係なく常に出る
//      （locked のときだけ補足ラベルが付く）
//   3. 拡張ホストからの `worktreeResult` の扱い（成功で閉じる / 失敗はエラー表示）

import type { Worktree } from "@openai-agent/types"

import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { DeleteWorktreeModal } from "../DeleteWorktreeModal"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

// t() はキーをそのまま返す。表示の有無だけを見たいため。
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const postMessage = vi.mocked(vscode.postMessage)

const WORKTREE: Worktree = {
	path: "/home/dev/.agent/worktrees/project-ab12c",
	branch: "feature/x",
	commitHash: "2222222222222222222222222222222222222222",
	isCurrent: false,
	isBare: false,
	isDetached: false,
	isLocked: false,
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
	return { ...WORKTREE, ...overrides }
}

/** 拡張ホストからの応答を webview に届ける。 */
function postFromHost(data: unknown): void {
	fireEvent(window, new MessageEvent("message", { data }))
}

function renderModal(overrides: Partial<Parameters<typeof DeleteWorktreeModal>[0]> = {}) {
	const onClose = vi.fn()
	const props = { open: true, onClose, worktree: WORKTREE, ...overrides }
	const view = render(<DeleteWorktreeModal {...props} />)
	return { ...view, onClose, onSuccess: props.onSuccess }
}

beforeEach(() => {
	vi.clearAllMocks()
})

// ===========================================================================
// 不変条件 1: force は明示的なオプトインのときだけ
// ===========================================================================

describe("DeleteWorktreeModal - worktreeForce（不変条件 1）", () => {
	it("【不変条件】locked でない worktree でも worktreeForce: false を送る", async () => {
		renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		expect(postMessage.mock.calls).toEqual([
			[
				{
					type: "deleteWorktree",
					worktreePath: WORKTREE.path,
					worktreeForce: false,
				},
			],
		])
	})

	it("【不変条件】locked な worktree でも既定は worktreeForce: false", async () => {
		const worktree = makeWorktree({ isLocked: true, lockReason: "in use" })
		renderModal({ worktree })

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		expect(postMessage.mock.calls).toEqual([
			[
				{
					type: "deleteWorktree",
					worktreePath: worktree.path,
					worktreeForce: false,
				},
			],
		])
	})

	it("チェックボックスを入れたときだけ worktreeForce: true になる", async () => {
		renderModal()

		fireEvent.click(screen.getByRole("checkbox"))
		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		expect(postMessage.mock.calls).toEqual([
			[
				{
					type: "deleteWorktree",
					worktreePath: WORKTREE.path,
					worktreeForce: true,
				},
			],
		])
	})

	it("チェックを外し直すと worktreeForce: false に戻る", async () => {
		renderModal()

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)
		fireEvent.click(checkbox)
		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		expect(postMessage.mock.calls).toEqual([
			[
				{
					type: "deleteWorktree",
					worktreePath: WORKTREE.path,
					worktreeForce: false,
				},
			],
		])
	})
})

// ===========================================================================
// 不変条件 2: チェックボックスは常に出る
// ===========================================================================

describe("DeleteWorktreeModal - 強制削除のチェックボックス（不変条件 2）", () => {
	it("locked でなくてもチェックボックスは表示され、補足ラベルは付かない", () => {
		renderModal()

		expect(screen.getByRole("checkbox")).toBeInTheDocument()
		expect(screen.getByText("worktrees:forceDelete")).toBeInTheDocument()
		expect(screen.queryByText("(worktrees:worktreeIsLocked)")).not.toBeInTheDocument()
	})

	it("locked のときは補足ラベルが付く", () => {
		renderModal({ worktree: makeWorktree({ isLocked: true }) })

		expect(screen.getByRole("checkbox")).toBeInTheDocument()
		expect(screen.getByText("(worktrees:worktreeIsLocked)")).toBeInTheDocument()
	})
})

// ===========================================================================
// 表示
// ===========================================================================

describe("DeleteWorktreeModal - 表示", () => {
	it("ブランチ名とパスを出す", () => {
		renderModal()

		expect(screen.getByText("feature/x")).toBeInTheDocument()
		expect(screen.getByText(WORKTREE.path)).toBeInTheDocument()
		expect(screen.getByText("worktrees:deleteWorktree")).toBeInTheDocument()
	})

	it("detached HEAD ならその旨を出す", () => {
		renderModal({ worktree: makeWorktree({ branch: "", isDetached: true }) })

		expect(screen.getByText("worktrees:detachedHead")).toBeInTheDocument()
	})

	it("ブランチも detached でもなければ noBranch を出す", () => {
		renderModal({ worktree: makeWorktree({ branch: "", isDetached: false }) })

		expect(screen.getByText("worktrees:noBranch")).toBeInTheDocument()
	})

	it("削除中はボタンが disabled になり、ラベルが deleting に変わる", () => {
		renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		const deleting = screen.getByRole("button", { name: "worktrees:deleting" })
		expect(deleting).toBeDisabled()
		expect(screen.queryByRole("button", { name: "worktrees:delete" })).not.toBeInTheDocument()
	})
})

// ===========================================================================
// 不変条件 3: worktreeResult の扱い
// ===========================================================================

describe("DeleteWorktreeModal - worktreeResult の扱い（不変条件 3）", () => {
	it("成功なら onSuccess と onClose を呼ぶ", () => {
		const onSuccess = vi.fn()
		const { onClose } = renderModal({ onSuccess })

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({ type: "worktreeResult", success: true })

		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("onSuccess 未指定でも成功で閉じる", () => {
		const { onClose } = renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({ type: "worktreeResult", success: true })

		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("失敗ならメッセージを表示し、閉じない", () => {
		const onSuccess = vi.fn()
		const { onClose } = renderModal({ onSuccess })

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({
			type: "worktreeResult",
			success: false,
			text: "Refusing to remove the worktree currently open: /workspace/project",
		})

		expect(
			screen.getByText("Refusing to remove the worktree currently open: /workspace/project"),
		).toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()
		expect(onSuccess).not.toHaveBeenCalled()
		// 再試行できるようにボタンは戻る。
		expect(screen.getByRole("button", { name: "worktrees:delete" })).toBeEnabled()
	})

	it("失敗の本文が無ければ Unknown error を出す", () => {
		renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({ type: "worktreeResult", success: false })

		expect(screen.getByText("Unknown error")).toBeInTheDocument()
	})

	it("再試行すると前回のエラー表示が消える", () => {
		renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({ type: "worktreeResult", success: false, text: "EBUSY" })
		expect(screen.getByText("EBUSY")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))

		expect(screen.queryByText("EBUSY")).not.toBeInTheDocument()
	})

	it("worktreeResult 以外のメッセージは無視する", () => {
		const { onClose } = renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
		postFromHost({ type: "worktreeList", worktrees: [] })

		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "worktrees:deleting" })).toBeDisabled()
	})

	it("閉じた後に届いた結果では onClose を呼ばない（リスナが外れている）", () => {
		const { onClose, unmount } = renderModal()

		unmount()
		postFromHost({ type: "worktreeResult", success: true })

		expect(onClose).not.toHaveBeenCalled()
	})
})

// ===========================================================================
// 閉じる経路
// ===========================================================================

describe("DeleteWorktreeModal - 閉じる経路", () => {
	it("キャンセルで onClose を呼び、メッセージは送らない", () => {
		const { onClose } = renderModal()

		fireEvent.click(screen.getByRole("button", { name: "worktrees:cancel" }))

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("Escape でダイアログが閉じると onClose を呼ぶ", () => {
		const { onClose } = renderModal()

		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" })

		expect(onClose).toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("open=false なら中身を描画しない", () => {
		renderModal({ open: false })

		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
	})
})
