// npx vitest run src/components/settings/__tests__/ModelProxySettingsControl.spec.tsx
//
// Model（API 設定プロファイル）単位の proxy コントロール。
//
// 3 状態をチェックボックス 1 つと URL 欄で表す。URL 欄は常に出す（OFF では無効化）。
// 値は VS Code 設定ではなくプロファイルに書く——ここを取り違えると、プロファイルを
// 切り替えても proxy が変わらず、この機能が存在する理由そのものを失う。

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProviderSettings } from "@openai-agent/types"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				data-testid={testId}
			/>
			{children}
		</label>
	),
}))

// VSCodeTextField は web component で value セッターを持たず fireEvent が値を差し込めない。
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, disabled, "data-testid": testId }: any) => (
		<div>
			{children}
			<input value={value} onChange={onInput} disabled={disabled} data-testid={testId} />
		</div>
	),
}))

import { ModelProxySettingsControl } from "../ModelProxySettingsControl"

const setField = vi.fn()
const renderWith = (apiConfiguration: Partial<ProviderSettings>) =>
	render(
		<ModelProxySettingsControl
			apiConfiguration={apiConfiguration as ProviderSettings}
			setApiConfigurationField={setField}
		/>,
	)

beforeEach(() => setField.mockReset())

describe("ModelProxySettingsControl", () => {
	it("未設定では OFF、URL 欄は出ているが無効", () => {
		renderWith({})
		expect(screen.getByTestId("model-proxy-enable-checkbox")).not.toBeChecked()
		// 条件付きで消さない。消すと値が残っているのに消えたように見える。
		expect(screen.getByTestId("model-proxy-url-input")).toBeDisabled()
	})

	it("ON にすると direct（URL が空のため）を書く", () => {
		renderWith({})
		fireEvent.click(screen.getByTestId("model-proxy-enable-checkbox"))
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "direct")
	})

	it("URL が入った状態で ON にすると custom を書く", () => {
		renderWith({ openAiProxyUrl: "socks5://127.0.0.1:1080" })
		fireEvent.click(screen.getByTestId("model-proxy-enable-checkbox"))
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "custom")
	})

	it("OFF にすると inherit へ戻す", () => {
		renderWith({ openAiProxyMode: "custom", openAiProxyUrl: "socks5://h:1080" })
		fireEvent.click(screen.getByTestId("model-proxy-enable-checkbox"))
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "inherit")
	})

	it("ON のとき URL を入れると URL と custom の両方を書く", () => {
		renderWith({ openAiProxyMode: "direct" })
		fireEvent.change(screen.getByTestId("model-proxy-url-input"), {
			target: { value: "socks5://127.0.0.1:1080" },
		})
		expect(setField).toHaveBeenCalledWith("openAiProxyUrl", "socks5://127.0.0.1:1080")
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "custom")
	})

	it("ON のとき URL を消すと direct へ落ちる", () => {
		renderWith({ openAiProxyMode: "custom", openAiProxyUrl: "socks5://h:1080" })
		fireEvent.change(screen.getByTestId("model-proxy-url-input"), { target: { value: "" } })
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "direct")
	})
})
