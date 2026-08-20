// npx vitest src/components/modes/__tests__/DeleteModeDialog.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { DeleteModeDialog } from "../DeleteModeDialog"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
	}),
}))

describe("DeleteModeDialog", () => {
	it("renders nothing about a mode when modeToDelete is null", () => {
		render(<DeleteModeDialog open={true} onOpenChange={vi.fn()} modeToDelete={null} onConfirm={vi.fn()} />)
		expect(screen.getByText("prompts:deleteMode.title")).toBeInTheDocument()
		// modeToDelete が null なのでメッセージ本文は描画されない
		expect(screen.queryByText(/prompts:deleteMode\.message/)).not.toBeInTheDocument()
	})

	it("shows the mode message and the rules folder note when a folder path is present", () => {
		render(
			<DeleteModeDialog
				open={true}
				onOpenChange={vi.fn()}
				modeToDelete={{ slug: "m1", name: "Mode One", rulesFolderPath: "/rules/m1" }}
				onConfirm={vi.fn()}
			/>,
		)
		expect(screen.getByText(/prompts:deleteMode\.message/)).toHaveTextContent("Mode One")
		expect(screen.getByText(/prompts:deleteMode\.rulesFolder/)).toHaveTextContent("/rules/m1")
	})

	it("omits the rules folder note when there is no folder path", () => {
		render(
			<DeleteModeDialog
				open={true}
				onOpenChange={vi.fn()}
				modeToDelete={{ slug: "m2", name: "Mode Two" }}
				onConfirm={vi.fn()}
			/>,
		)
		expect(screen.getByText(/prompts:deleteMode\.message/)).toBeInTheDocument()
		expect(screen.queryByText(/prompts:deleteMode\.rulesFolder/)).not.toBeInTheDocument()
	})

	it("calls onConfirm when the confirm action is clicked", () => {
		const onConfirm = vi.fn()
		render(
			<DeleteModeDialog
				open={true}
				onOpenChange={vi.fn()}
				modeToDelete={{ slug: "m3", name: "Mode Three" }}
				onConfirm={onConfirm}
			/>,
		)
		fireEvent.click(screen.getByText("prompts:deleteMode.confirm"))
		expect(onConfirm).toHaveBeenCalledTimes(1)
	})
})
