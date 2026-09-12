import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import type { SkillSource } from "@openai-agent/types"

import { SkillSourcesSettings, isSshUrl } from "../SkillSourcesSettings"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, className, disabled, "data-testid": testId, children }: any) => (
		<div className={className}>
			{children}
			<input
				value={value}
				placeholder={placeholder}
				disabled={disabled}
				data-testid={testId}
				onChange={onInput}
			/>
		</div>
	),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label>
			<input type="checkbox" checked={checked} data-testid={testId} onChange={() => onChange(!checked)} />
			{children}
		</label>
	),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick, "data-testid": testId }: any) => (
		<button onClick={onClick} data-testid={testId}>
			{children}
		</button>
	),
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

const postMessage = vi.hoisted(() => vi.fn())
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage } }))

const renderWith = (sources: SkillSource[]) => {
	const setSkillSources = vi.fn()
	render(<SkillSourcesSettings skillSources={sources} setSkillSources={setSkillSources} />)
	return setSkillSources
}

describe("isSshUrl（FR-EXT-05b3 / FR-UI-29a）", () => {
	it.each(["git@host:a/b.git", "ssh://git@host/a/b", "host:a/b"])("%s は SSH と見なす", (url) => {
		expect(isSshUrl(url)).toBe(true)
	})

	it.each(["https://host/a/b", "http://host/a/b", "  https://host/a/b  ", ""])("%s は SSH と見なさない", (url) => {
		expect(isSshUrl(url)).toBe(false)
	})
})

describe("SkillSourcesSettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("取得元が無いときはその旨を出す", () => {
		renderWith([])

		expect(screen.getByText("settings:skills.sources.none")).toBeInTheDocument()
	})

	it("取得元を足す", () => {
		const setSkillSources = renderWith([])

		fireEvent.click(screen.getByTestId("skill-source-add"))

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "" }])
	})

	it("取得元を取り除く", () => {
		const setSkillSources = renderWith([{ url: "https://host/a" }, { url: "https://host/b" }])

		fireEvent.click(screen.getByTestId("skill-source-remove-0"))

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "https://host/b" }])
	})

	it("URL を書き換える", () => {
		const setSkillSources = renderWith([{ url: "https://host/a" }])

		fireEvent.change(screen.getByTestId("skill-source-url-0"), { target: { value: "https://host/z" } })

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "https://host/z" }])
	})

	it("押した行の値をそのまま送る。保存の前でも試せる（FR-EXT-05a）", () => {
		renderWith([{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p:1080" }])

		fireEvent.click(screen.getByTestId("skill-source-fetch-0"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "fetchSkillSource",
			values: { url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p:1080" },
		})
	})

	it("描画しただけでは通信しない（FR-EXT-05a）", () => {
		renderWith([{ url: "https://host/a" }])

		expect(postMessage).not.toHaveBeenCalled()
	})

	it("SSH の取得元では proxy を選ばせず、効かない旨を出す（FR-UI-29a）", () => {
		renderWith([{ url: "git@host:a/b.git", proxyMode: "custom", proxyUrl: "socks5://p:1080" }])

		expect(screen.getByTestId("skill-source-ssh-note-0")).toBeInTheDocument()
		expect(screen.getByTestId("skill-source-proxy-0-url-input")).toBeDisabled()
	})

	it("HTTPS の取得元では proxy を選べる", () => {
		renderWith([{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p:1080" }])

		expect(screen.queryByTestId("skill-source-ssh-note-0")).not.toBeInTheDocument()
		expect(screen.getByTestId("skill-source-proxy-0-url-input")).not.toBeDisabled()
	})

	it("proxy の URL を書き換えると custom になる", () => {
		const setSkillSources = renderWith([{ url: "https://host/a", proxyMode: "custom", proxyUrl: "" }])

		fireEvent.change(screen.getByTestId("skill-source-proxy-0-url-input"), {
			target: { value: "socks5://p:1080" },
		})

		expect(setSkillSources).toHaveBeenCalledWith([
			{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p:1080" },
		])
	})

	it("proxy を切ると継承に戻る", () => {
		const setSkillSources = renderWith([{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p" }])

		fireEvent.click(screen.getByTestId("skill-source-proxy-0-enable-checkbox"))

		expect(setSkillSources).toHaveBeenCalledWith([
			{ url: "https://host/a", proxyMode: "inherit", proxyUrl: "socks5://p" },
		])
	})

	it("複数あるとき、押した行だけ書き換える", () => {
		const setSkillSources = renderWith([{ url: "https://host/a" }, { url: "https://host/b" }])

		fireEvent.change(screen.getByTestId("skill-source-url-1"), { target: { value: "https://host/z" } })

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "https://host/a" }, { url: "https://host/z" }])
	})

	it("proxy を入れると、URL が空なら直結になる", () => {
		const setSkillSources = renderWith([{ url: "https://host/a" }])

		fireEvent.click(screen.getByTestId("skill-source-proxy-0-enable-checkbox"))

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "https://host/a", proxyMode: "direct", proxyUrl: "" }])
	})

	it("proxy を入れて URL があれば個別の指定になる", () => {
		const setSkillSources = renderWith([{ url: "https://host/a", proxyMode: "inherit", proxyUrl: "socks5://p" }])

		fireEvent.click(screen.getByTestId("skill-source-proxy-0-enable-checkbox"))

		expect(setSkillSources).toHaveBeenCalledWith([
			{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p" },
		])
	})

	it("proxy の URL を空にすると直結になる", () => {
		const setSkillSources = renderWith([{ url: "https://host/a", proxyMode: "custom", proxyUrl: "socks5://p" }])

		fireEvent.change(screen.getByTestId("skill-source-proxy-0-url-input"), { target: { value: "" } })

		expect(setSkillSources).toHaveBeenCalledWith([{ url: "https://host/a", proxyMode: "direct", proxyUrl: "" }])
	})

	it("proxy が切れているあいだに URL を書いても、継承のままにする", () => {
		const setSkillSources = renderWith([{ url: "https://host/a" }])

		fireEvent.change(screen.getByTestId("skill-source-proxy-0-url-input"), { target: { value: "socks5://p" } })

		expect(setSkillSources).toHaveBeenCalledWith([
			{ url: "https://host/a", proxyMode: "inherit", proxyUrl: "socks5://p" },
		])
	})

	it("取得元が未設定でも描ける", () => {
		render(<SkillSourcesSettings skillSources={undefined} setSkillSources={() => {}} />)

		expect(screen.getByText("settings:skills.sources.none")).toBeInTheDocument()
	})
})
