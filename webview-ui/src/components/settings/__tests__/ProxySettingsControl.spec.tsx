import { render, screen, fireEvent, act } from "@testing-library/react"

import { ProxySettingsControl } from "../ProxySettingsControl"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange, checked, ...props }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				{...props}
			/>
			{children}
		</label>
	),
	VSCodeTextField: ({ children, onInput, value, ...props }: any) => (
		<label>
			{children}
			<input value={value} onChange={(e) => onInput({ target: { value: e.target.value } })} {...props} />
		</label>
	),
}))

// vsCodeSetting メッセージを webview へ届ける。
function deliverSetting(value: unknown) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "vsCodeSetting", setting: "openai-agent.proxyUrl", value } }),
		)
	})
}

beforeEach(() => postMessage.mockClear())

describe("ProxySettingsControl", () => {
	it("マウント時に proxyUrl の取得を要求する", () => {
		render(<ProxySettingsControl />)
		expect(postMessage).toHaveBeenCalledWith({ type: "getVSCodeSetting", setting: "openai-agent.proxyUrl" })
	})

	it("既定（空）は『VS Code に従う』チェック・URL 欄なし", () => {
		render(<ProxySettingsControl />)
		deliverSetting("")
		expect(screen.getByTestId("proxy-follow-default-checkbox")).toBeChecked()
		expect(screen.queryByTestId("proxy-url-input")).not.toBeInTheDocument()
	})

	it("保存済み URL があればチェック外れ・URL 欄に反映", () => {
		render(<ProxySettingsControl />)
		deliverSetting("socks5://127.0.0.1:1080")
		expect(screen.getByTestId("proxy-follow-default-checkbox")).not.toBeChecked()
		expect(screen.getByTestId("proxy-url-input")).toHaveValue("socks5://127.0.0.1:1080")
	})

	it("チェックを外すと URL 欄が出る", () => {
		render(<ProxySettingsControl />)
		deliverSetting("")
		fireEvent.click(screen.getByTestId("proxy-follow-default-checkbox"))
		expect(screen.getByTestId("proxy-url-input")).toBeInTheDocument()
	})

	it("URL を入力すると updateVSCodeSetting を送る", () => {
		render(<ProxySettingsControl />)
		deliverSetting("")
		fireEvent.click(screen.getByTestId("proxy-follow-default-checkbox"))
		fireEvent.change(screen.getByTestId("proxy-url-input"), { target: { value: "http://p:3128" } })
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateVSCodeSetting",
			setting: "openai-agent.proxyUrl",
			value: "http://p:3128",
		})
	})

	it("無関係なメッセージ（別 setting / 別 type）は無視する", () => {
		render(<ProxySettingsControl />)
		deliverSetting("http://p:1")
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "vsCodeSetting", setting: "other", value: "x" } }),
			)
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action" } }))
		})
		// 直前に届いた proxyUrl のまま
		expect(screen.getByTestId("proxy-url-input")).toHaveValue("http://p:1")
	})

	it("value が文字列でない（number 等）は空扱い", () => {
		render(<ProxySettingsControl />)
		deliverSetting(123 as unknown)
		expect(screen.getByTestId("proxy-follow-default-checkbox")).toBeChecked()
		expect(screen.queryByTestId("proxy-url-input")).not.toBeInTheDocument()
	})

	it("『VS Code に従う』を入れ直すと URL をクリアして空で保存", () => {
		render(<ProxySettingsControl />)
		deliverSetting("socks5://127.0.0.1:1080")
		fireEvent.click(screen.getByTestId("proxy-follow-default-checkbox"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateVSCodeSetting",
			setting: "openai-agent.proxyUrl",
			value: "",
		})
		expect(screen.queryByTestId("proxy-url-input")).not.toBeInTheDocument()
	})
})
