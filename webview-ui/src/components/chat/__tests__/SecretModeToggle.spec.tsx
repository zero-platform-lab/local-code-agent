// npx vitest run src/components/chat/__tests__/SecretModeToggle.spec.tsx
//
// 会話の画面のシークレットモードの切り替え（FR-PII-01b）。
//
// **切れているのに気づかないほうが害が大きい。** 伏せたつもりで送ってしまう。
// 入っているか切れているかが、押さなくても分かることを固定する。

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import { SecretModeToggle } from "../SecretModeToggle"

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

describe("SecretModeToggle", () => {
	it("未設定では切れている（FR-PII-01a）", () => {
		render(<SecretModeToggle />)

		expect(screen.getByTestId("secret-mode-toggle")).toHaveAttribute("aria-pressed", "false")
	})

	it("入っているかが、押さなくても分かる", () => {
		state.value = { piiMasking: { enabled: true } }
		render(<SecretModeToggle />)

		const button = screen.getByTestId("secret-mode-toggle")
		expect(button).toHaveAttribute("aria-pressed", "true")
		expect(button.parentElement).toHaveAttribute("data-tooltip", "chat:secretMode.on")
	})

	it("押すと入る", () => {
		render(<SecretModeToggle />)

		fireEvent.click(screen.getByTestId("secret-mode-toggle"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { piiMasking: { enabled: true } },
		})
	})

	it("押すと切れる。ほかの設定は残す", () => {
		state.value = { piiMasking: { enabled: true, kinds: ["email"], dictionaryPaths: ["/a.txt"] } }
		render(<SecretModeToggle />)

		fireEvent.click(screen.getByTestId("secret-mode-toggle"))

		// 切り替えだけを変える。種類や辞書の設定を巻き添えで消さない。
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { piiMasking: { enabled: false, kinds: ["email"], dictionaryPaths: ["/a.txt"] } },
		})
	})

	it("描いただけでは送らない", () => {
		render(<SecretModeToggle />)

		expect(postMessage).not.toHaveBeenCalled()
	})
})
