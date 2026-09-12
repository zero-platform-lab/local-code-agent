import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import type { PiiMasking } from "@openai-agent/types"

import { PiiSettings } from "../PiiSettings"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, className, disabled, "data-testid": testId }: any) => (
		<input
			className={className}
			value={value}
			placeholder={placeholder}
			disabled={disabled}
			data-testid={testId}
			onChange={onInput}
		/>
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

vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))

const postMessage = vi.hoisted(() => vi.fn())
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage } }))

const renderWith = (piiMasking?: PiiMasking) => {
	const setPiiMasking = vi.fn()
	render(<PiiSettings piiMasking={piiMasking} setPiiMasking={setPiiMasking} />)
	return setPiiMasking
}

beforeEach(() => vi.clearAllMocks())

describe("シークレットモード（FR-PII-01）", () => {
	it("いまの状態を出すだけで、ここでは切り替えない（FR-PII-01b）", () => {
		renderWith()

		// 2 か所から同じ値を書くと、保存が会話の画面での切り替えを巻き戻す。
		expect(screen.queryByTestId("pii-enabled-checkbox")).not.toBeInTheDocument()
		expect(screen.getByTestId("pii-enabled-state")).toHaveTextContent("settings:pii.stateOff")
	})

	it("入っていればそう出す", () => {
		renderWith({ enabled: true })

		expect(screen.getByTestId("pii-enabled-state")).toHaveTextContent("settings:pii.stateOn")
	})
})

describe("伏せる種類（FR-PII-07）", () => {
	it("未設定では全部の種類が入る", () => {
		renderWith()

		expect(screen.getByTestId("pii-kind-email")).toBeChecked()
		expect(screen.getByTestId("pii-kind-address")).toBeChecked()
		expect(screen.queryByTestId("pii-no-kinds")).not.toBeInTheDocument()
	})

	it("種類を外せる", () => {
		const setPiiMasking = renderWith({ kinds: ["email", "phone"] })

		fireEvent.click(screen.getByTestId("pii-kind-email"))

		expect(setPiiMasking).toHaveBeenCalledWith({ kinds: ["phone"] })
	})

	it("種類を足せる", () => {
		const setPiiMasking = renderWith({ kinds: ["email"] })

		fireEvent.click(screen.getByTestId("pii-kind-phone"))

		expect(setPiiMasking).toHaveBeenCalledWith({ kinds: ["email", "phone"] })
	})

	it("1 つも選んでいなければ、伏せられない旨を出す", () => {
		renderWith({ kinds: [] })

		// 種類を全部切っても切り替えは有効のままになり得る。伏せているつもりを防ぐ。
		expect(screen.getByTestId("pii-no-kinds")).toBeInTheDocument()
	})
})

describe("辞書のファイル（FR-PII-16）", () => {
	it("未設定ではその旨を出す", () => {
		renderWith()

		expect(screen.getByText("settings:pii.noDictionary")).toBeInTheDocument()
	})

	it("辞書を足す", () => {
		const setPiiMasking = renderWith()

		fireEvent.click(screen.getByTestId("pii-dictionary-add"))

		expect(setPiiMasking).toHaveBeenCalledWith({ dictionaryPaths: [""] })
	})

	it("パスを書き換える", () => {
		const setPiiMasking = renderWith({ dictionaryPaths: ["/a.txt", "/b.txt"] })

		fireEvent.change(screen.getByTestId("pii-dictionary-1"), { target: { value: "/z.txt" } })

		expect(setPiiMasking).toHaveBeenCalledWith({ dictionaryPaths: ["/a.txt", "/z.txt"] })
	})

	it("辞書を取り除く", () => {
		const setPiiMasking = renderWith({ dictionaryPaths: ["/a.txt", "/b.txt"] })

		fireEvent.click(screen.getByTestId("pii-dictionary-remove-0"))

		expect(setPiiMasking).toHaveBeenCalledWith({ dictionaryPaths: ["/b.txt"] })
	})

	it("無ければ作って開く。~ の展開は拡張ホストへ任せる", () => {
		renderWith({ dictionaryPaths: ["~/.agent/pii-dictionary.txt"] })

		fireEvent.click(screen.getByTestId("pii-dictionary-open-0"))

		// webview は生の文字列しか持たない。ここで解決すると `~` のディレクトリを作る。
		expect(postMessage).toHaveBeenCalledWith({
			type: "openPiiDictionary",
			text: "~/.agent/pii-dictionary.txt",
		})
	})
})

describe("書き出し（FR-PII-17）", () => {
	it("押したときだけ送る", () => {
		renderWith()

		expect(postMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("pii-export"))

		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({ type: "exportPiiDictionary" })
	})
})
