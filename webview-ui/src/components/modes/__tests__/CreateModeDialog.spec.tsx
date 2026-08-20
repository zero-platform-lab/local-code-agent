// npx vitest src/components/modes/__tests__/CreateModeDialog.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import { CreateModeDialog } from "../CreateModeDialog"
import { availableGroups, emptyFieldErrors, type ModeDraft, type ModeFieldErrors } from "../modeFormLogic"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// 素の要素に差し替える。ラジオ/チェックボックスは e.target 経路と detail.target 経路の
// 両方を発火できるように補助ボタンを添える。
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange }: { value?: string; onChange?: (e: unknown) => void }) => (
		<input type="text" value={value} onChange={onChange} />
	),
	VSCodeTextArea: ({ value, onChange }: { value?: string; onChange?: (e: unknown) => void }) => (
		<textarea value={value} onChange={onChange} />
	),
	VSCodeCheckbox: ({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (e: unknown) => void
	}) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={onChange} />
			<button
				type="button"
				data-testid="group-detail"
				onClick={() => onChange?.({ detail: { target: { checked: true } } })}>
				detail
			</button>
			{children}
		</label>
	),
	VSCodeRadioGroup: ({
		children,
		value,
		onChange,
	}: {
		children?: React.ReactNode
		value?: string
		onChange?: (e: unknown) => void
	}) => (
		<div>
			<select data-testid="source-select" value={value} onChange={onChange}>
				<option value="global">global</option>
				<option value="project">project</option>
			</select>
			<button
				type="button"
				data-testid="source-detail"
				onClick={() => onChange?.({ detail: { target: { value: "project" } } })}>
				detail
			</button>
			{children}
		</div>
	),
	VSCodeRadio: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

const makeDraft = (overrides: Partial<ModeDraft> = {}): ModeDraft => ({
	name: "",
	slug: "",
	description: "",
	roleDefinition: "",
	whenToUse: "",
	customInstructions: "",
	groups: availableGroups,
	source: "global",
	...overrides,
})

const renderDialog = (opts: { draft?: ModeDraft; errors?: ModeFieldErrors } = {}) => {
	const setField = vi.fn()
	const onNameChange = vi.fn()
	const onCancel = vi.fn()
	const onCreate = vi.fn()
	render(
		<CreateModeDialog
			draft={opts.draft ?? makeDraft()}
			errors={opts.errors ?? emptyFieldErrors}
			setField={setField}
			onNameChange={onNameChange}
			onCancel={onCancel}
			onCreate={onCreate}
		/>,
	)
	return { setField, onNameChange, onCancel, onCreate }
}

describe("CreateModeDialog", () => {
	it("wires each text field to the right update handler", () => {
		const { setField, onNameChange } = renderDialog()
		const boxes = screen.getAllByRole("textbox")
		// 順序: name, slug, roleDefinition, description, whenToUse, customInstructions
		fireEvent.change(boxes[0], { target: { value: "My Mode" } })
		expect(onNameChange).toHaveBeenCalledWith("My Mode")

		fireEvent.change(boxes[1], { target: { value: "my-slug" } })
		expect(setField).toHaveBeenCalledWith("slug", "my-slug")

		fireEvent.change(boxes[2], { target: { value: "role" } })
		expect(setField).toHaveBeenCalledWith("roleDefinition", "role")

		fireEvent.change(boxes[3], { target: { value: "desc" } })
		expect(setField).toHaveBeenCalledWith("description", "desc")

		fireEvent.change(boxes[4], { target: { value: "when" } })
		expect(setField).toHaveBeenCalledWith("whenToUse", "when")

		fireEvent.change(boxes[5], { target: { value: "instr" } })
		expect(setField).toHaveBeenCalledWith("customInstructions", "instr")
	})

	it("updates source from a native change event (e.target path)", () => {
		const { setField } = renderDialog()
		fireEvent.change(screen.getByTestId("source-select"), { target: { value: "project" } })
		expect(setField).toHaveBeenCalledWith("source", "project")
	})

	it("updates source from a CustomEvent detail.target path", () => {
		const { setField } = renderDialog()
		fireEvent.click(screen.getByTestId("source-detail"))
		expect(setField).toHaveBeenCalledWith("source", "project")
	})

	it("toggles a group from a native checkbox change (e.target path)", () => {
		// 既定は全グループ有効 → 先頭チェックボックスを外す
		const { setField } = renderDialog()
		const checkbox = screen.getAllByRole("checkbox")[0]
		fireEvent.click(checkbox)
		expect(setField).toHaveBeenCalledWith("groups", expect.any(Array))
	})

	it("toggles a group from a CustomEvent detail.target path", () => {
		const { setField } = renderDialog()
		fireEvent.click(screen.getAllByTestId("group-detail")[0])
		expect(setField).toHaveBeenCalledWith("groups", expect.any(Array))
	})

	it("shows checkboxes as unchecked when the draft has no groups", () => {
		renderDialog({ draft: makeDraft({ groups: [] }) })
		const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[]
		expect(checkboxes.every((c) => !c.checked)).toBe(true)
	})

	it("renders all field errors when present", () => {
		renderDialog({
			errors: {
				...emptyFieldErrors,
				name: "name-error",
				slug: "slug-error",
				roleDefinition: "role-error",
				description: "desc-error",
				groups: "groups-error",
			},
		})
		expect(screen.getByText("name-error")).toBeInTheDocument()
		expect(screen.getByText("slug-error")).toBeInTheDocument()
		expect(screen.getByText("role-error")).toBeInTheDocument()
		expect(screen.getByText("desc-error")).toBeInTheDocument()
		expect(screen.getByText("groups-error")).toBeInTheDocument()
	})

	it("calls onCancel and onCreate from the footer buttons", () => {
		const { onCancel, onCreate } = renderDialog()
		fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.cancel"))
		expect(onCancel).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByText("prompts:createModeDialog.buttons.create"))
		expect(onCreate).toHaveBeenCalledTimes(1)
	})
})
