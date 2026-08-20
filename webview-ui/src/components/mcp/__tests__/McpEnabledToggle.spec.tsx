// npx vitest src/components/mcp/__tests__/McpEnabledToggle.spec.tsx

import React from "react"
import { render, fireEvent, screen } from "@/utils/test-utils"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import McpEnabledToggle from "../McpEnabledToggle"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// VSCodeCheckbox を素の input に差し替える。加えて「target を持たないイベント」を
// 発火するための補助ボタンを提供し、handleChange のガード分岐を踏めるようにする。
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: function MockVSCodeCheckbox({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (e: unknown) => void
	}) {
		return (
			<label>
				<input type="checkbox" checked={checked} onChange={onChange} data-testid="mcp-enabled-checkbox" />
				<button data-testid="mcp-enabled-no-target" onClick={() => onChange?.({})}>
					no-target
				</button>
				{children}
			</label>
		)
	},
}))

const renderToggle = (mcpEnabled: boolean, setMcpEnabled = vi.fn()) => {
	render(
		<ExtensionStateContext.Provider value={{ mcpEnabled, setMcpEnabled } as never}>
			<McpEnabledToggle />
		</ExtensionStateContext.Provider>,
	)
	return { setMcpEnabled }
}

describe("McpEnabledToggle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reflects the current mcpEnabled state", () => {
		renderToggle(true)
		const checkbox = screen.getByTestId("mcp-enabled-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("enables mcp and posts updateSettings when toggled on", () => {
		const { setMcpEnabled } = renderToggle(false)

		fireEvent.click(screen.getByTestId("mcp-enabled-checkbox"))

		expect(setMcpEnabled).toHaveBeenCalledWith(true)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})
	})

	it("disables mcp and posts updateSettings when toggled off", () => {
		const { setMcpEnabled } = renderToggle(true)

		fireEvent.click(screen.getByTestId("mcp-enabled-checkbox"))

		expect(setMcpEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})
	})

	// target を持たないイベントでは何もしない（`"target" in e` 偽 → ガード return）。
	it("does nothing when the change event has no target", () => {
		const { setMcpEnabled } = renderToggle(false)

		fireEvent.click(screen.getByTestId("mcp-enabled-no-target"))

		expect(setMcpEnabled).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
