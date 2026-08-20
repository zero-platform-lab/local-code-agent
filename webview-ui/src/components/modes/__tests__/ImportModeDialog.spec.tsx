// npx vitest src/components/modes/__tests__/ImportModeDialog.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { ImportModeDialog } from "../ImportModeDialog"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const baseProps = () => ({
	level: "project" as const,
	onLevelChange: vi.fn(),
	isImporting: false,
	onCancel: vi.fn(),
	onImport: vi.fn(),
})

describe("ImportModeDialog", () => {
	it("marks the project radio as checked when level is project", () => {
		render(<ImportModeDialog {...baseProps()} level="project" />)
		const radios = screen.getAllByRole("radio") as HTMLInputElement[]
		const [project, global] = radios
		expect(project.checked).toBe(true)
		expect(global.checked).toBe(false)
	})

	it("marks the global radio as checked when level is global", () => {
		render(<ImportModeDialog {...baseProps()} level="global" />)
		const radios = screen.getAllByRole("radio") as HTMLInputElement[]
		const [project, global] = radios
		expect(project.checked).toBe(false)
		expect(global.checked).toBe(true)
	})

	// ラジオの onChange は値が変わるときだけ発火するので、選択したい側が未チェックの状態から始める。
	it("selects the global level when the global radio is chosen", () => {
		const onLevelChange = vi.fn()
		render(<ImportModeDialog {...baseProps()} level="project" onLevelChange={onLevelChange} />)
		fireEvent.click(screen.getAllByRole("radio")[1]) // global
		expect(onLevelChange).toHaveBeenCalledWith("global")
	})

	it("selects the project level when the project radio is chosen", () => {
		const onLevelChange = vi.fn()
		render(<ImportModeDialog {...baseProps()} level="global" onLevelChange={onLevelChange} />)
		fireEvent.click(screen.getAllByRole("radio")[0]) // project
		expect(onLevelChange).toHaveBeenCalledWith("project")
	})

	it("shows the import label and calls onImport when not importing", () => {
		const onImport = vi.fn()
		render(<ImportModeDialog {...baseProps()} isImporting={false} onImport={onImport} />)
		const importButton = screen.getByText("prompts:importMode.import")
		expect(importButton).not.toBeDisabled()
		fireEvent.click(importButton)
		expect(onImport).toHaveBeenCalledTimes(1)
	})

	it("shows the importing label and disables the button while importing", () => {
		render(<ImportModeDialog {...baseProps()} isImporting={true} />)
		const importButton = screen.getByText("prompts:importMode.importing")
		expect(importButton).toBeDisabled()
	})

	it("calls onCancel when cancel is clicked", () => {
		const onCancel = vi.fn()
		render(<ImportModeDialog {...baseProps()} onCancel={onCancel} />)
		fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.cancel"))
		expect(onCancel).toHaveBeenCalledTimes(1)
	})
})
