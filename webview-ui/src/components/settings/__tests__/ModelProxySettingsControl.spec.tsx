// npx vitest run src/components/settings/__tests__/ModelProxySettingsControl.spec.tsx
//
// Model（API 設定プロファイル）単位の proxy コントロール。
//
// 値は VS Code 設定ではなくプロファイルに書く。ここを取り違えると、プロファイルを
// 切り替えても proxy が変わらない（＝混在環境で片方が必ず通らない）という、この機能が
// 存在する理由そのものを失う。書き込み先を固定する。

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, "data-testid": testId }: any) => (
		<div>
			{children}
			<input value={value} onChange={onInput} data-testid={testId} />
		</div>
	),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<select value={value} onChange={(e: any) => onValueChange?.(e.target.value)} data-testid="select-root">
			{children}
		</select>
	),
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
}))

import { ModelProxySettingsControl } from "../ModelProxySettingsControl"

const setField = vi.fn()

const renderWith = (apiConfiguration: any) =>
	render(<ModelProxySettingsControl apiConfiguration={apiConfiguration} setApiConfigurationField={setField} />)

beforeEach(() => setField.mockReset())

describe("ModelProxySettingsControl", () => {
	it("未設定は inherit として表示する", () => {
		renderWith({})
		expect(screen.getByTestId("select-root")).toHaveValue("inherit")
	})

	it("選んだモードをプロファイルへ書く", () => {
		renderWith({})
		fireEvent.change(screen.getByTestId("select-root"), { target: { value: "direct" } })
		expect(setField).toHaveBeenCalledWith("openAiProxyMode", "direct")
	})

	it("URL 欄は custom のときだけ出る", () => {
		const { rerender } = renderWith({ openAiProxyMode: "inherit" })
		expect(screen.queryByTestId("model-proxy-url-input")).toBeNull()

		// direct でも URL は不要（proxy を使わないため）。
		rerender(
			<ModelProxySettingsControl
				apiConfiguration={{ openAiProxyMode: "direct" } as any}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.queryByTestId("model-proxy-url-input")).toBeNull()

		rerender(
			<ModelProxySettingsControl
				apiConfiguration={{ openAiProxyMode: "custom" } as any}
				setApiConfigurationField={setField}
			/>,
		)
		expect(screen.getByTestId("model-proxy-url-input")).toBeInTheDocument()
	})

	it("URL をプロファイルへ書く", () => {
		renderWith({ openAiProxyMode: "custom" })
		fireEvent.change(screen.getByTestId("model-proxy-url-input"), {
			target: { value: "socks5://127.0.0.1:1080" },
		})
		expect(setField).toHaveBeenCalledWith("openAiProxyUrl", "socks5://127.0.0.1:1080")
	})
})
