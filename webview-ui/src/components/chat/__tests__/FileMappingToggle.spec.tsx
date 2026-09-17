// npx vitest run src/components/chat/__tests__/FileMappingToggle.spec.tsx
//
// 会話の画面のファイル対応表の切り替え（FR-PII-24）。
//
// 入っていると、読んだファイルの伏せ字がディスクへ残る。入っているか切れているかが、
// 押さなくても分かることを固定する。

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import { FileMappingToggle } from "../FileMappingToggle"

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const postMessage = vi.hoisted(() => vi.fn())

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state.value }))

vi.mock("@src/components/ui", () => ({
	StandardTooltip: ({ children, content }: any) => <div data-tooltip={content}>{children}</div>,
	Button: ({ children, onClick, className, "aria-pressed": pressed, "data-testid": testId }: any) => (
		<button onClick={onClick} className={className} aria-pressed={pressed} data-testid={testId}>
			{children}
		</button>
	),
}))

beforeEach(() => {
	vi.clearAllMocks()
	state.value = {}
})

describe("FileMappingToggle", () => {
	it("未設定では切れている", () => {
		render(<FileMappingToggle />)

		expect(screen.getByTestId("file-mapping-toggle")).toHaveAttribute("aria-pressed", "false")
	})

	it("入っているかが、押さなくても分かる", () => {
		state.value = { piiMasking: { fileMapping: { enabled: true } } }
		render(<FileMappingToggle />)

		const button = screen.getByTestId("file-mapping-toggle")
		expect(button).toHaveAttribute("aria-pressed", "true")
		expect(button.parentElement).toHaveAttribute("data-tooltip", "chat:fileMapping.on")
	})

	it("押すと入る", () => {
		render(<FileMappingToggle />)

		fireEvent.click(screen.getByTestId("file-mapping-toggle"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { piiMasking: { fileMapping: { enabled: true } } },
		})
	})

	it("押すと切れる。ほかの設定は残す", () => {
		state.value = { piiMasking: { enabled: true, fileMapping: { enabled: true, retentionDays: 7 } } }
		render(<FileMappingToggle />)

		fireEvent.click(screen.getByTestId("file-mapping-toggle"))

		// 切り替えだけを変える。シークレットモードや保持日数を巻き添えで消さない。
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { piiMasking: { enabled: true, fileMapping: { enabled: false, retentionDays: 7 } } },
		})
	})

	it("描いただけでは送らない", () => {
		render(<FileMappingToggle />)

		expect(postMessage).not.toHaveBeenCalled()
	})
})
