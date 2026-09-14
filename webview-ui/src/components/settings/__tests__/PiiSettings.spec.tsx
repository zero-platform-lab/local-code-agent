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

		// 描画のときはモデルの場所を尋ねるだけで、書き出しは送らない。
		expect(postMessage.mock.calls.map(([one]) => one.type)).toEqual(["requestPiiNerModelStatus"])

		fireEvent.click(screen.getByTestId("pii-export"))

		expect(postMessage.mock.calls.filter(([one]) => one.type === "exportPiiDictionary")).toHaveLength(1)
		// **保存前の値を渡す。** 渡さないと、足したばかりの辞書が書き出しに入らない。
		expect(postMessage).toHaveBeenCalledWith({
			type: "exportPiiDictionary",
			values: { terms: undefined, dictionaryPaths: [] },
		})
	})
})

describe("固有名詞の検出（第 2 層）（FR-PII-21）", () => {
	it("既定では切で、製品名とイベント名は外れている（FR-PII-21b・FR-PII-21c）", () => {
		renderWith()

		// React が伏せ字になると、モデルは何の話か判断できなくなる。
		expect(screen.getByTestId("pii-proper-nouns-enabled")).not.toBeChecked()
		expect(screen.getByTestId("pii-entity-PER")).toBeChecked()
		expect(screen.getByTestId("pii-entity-ORG")).toBeChecked()
		expect(screen.getByTestId("pii-entity-PRD")).not.toBeChecked()
		expect(screen.getByTestId("pii-entity-EVT")).not.toBeChecked()
	})

	it("入切は第 1 層とは別に持つ", () => {
		// モデルを置いていない利用者のほうが多い。同じ切り替えにすると、入れたつもりで動かない。
		const set = renderWith({ enabled: true })

		fireEvent.click(screen.getByTestId("pii-proper-nouns-enabled"))

		expect(set).toHaveBeenCalledWith({ enabled: true, properNouns: { enabled: true } })
	})

	it("区分を外すと、外した一覧を書く（FR-PII-21a）", () => {
		const set = renderWith({ properNouns: { enabled: true } })

		fireEvent.click(screen.getByTestId("pii-entity-LOC"))

		expect(set.mock.calls[0][0].properNouns.entities).toEqual(["PER", "ORG", "ORG-P", "ORG-O", "INS"])
	})

	it("区分を足せる", () => {
		const set = renderWith({ properNouns: { enabled: true, entities: ["PER"] } })

		fireEvent.click(screen.getByTestId("pii-entity-ORG"))

		expect(set.mock.calls[0][0].properNouns.entities).toEqual(["PER", "ORG"])
	})

	it("置き場所を書ける", () => {
		const set = renderWith({ properNouns: { enabled: true } })

		fireEvent.change(screen.getByTestId("pii-model-path"), { target: { value: "~/models/ner" } })

		expect(set.mock.calls[0][0].properNouns.modelPath).toBe("~/models/ner")
	})

	it("取得は押した時点で拡張ホストへ送る（FR-PII-23c）", () => {
		// 設定ではなく操作なので、保存を待たない。
		renderWith({ properNouns: { enabled: true } })

		fireEvent.click(screen.getByTestId("pii-model-fetch"))

		// **保存前の置き場所を渡す。** 渡さないと、別の場所へ 282 MB を取ってしまう。
		expect(postMessage).toHaveBeenCalledWith({ type: "fetchPiiNerModel", text: "" })
	})
})

describe("保存前の値を渡す", () => {
	it("書き込んだ置き場所をそのまま送る（FR-PII-23c）", () => {
		// 保存を待たずに押せてしまうので、押した時点の値を渡す。
		renderWith({ properNouns: { enabled: true, modelPath: "~/models/ner" } })

		fireEvent.click(screen.getByTestId("pii-model-fetch"))

		expect(postMessage).toHaveBeenCalledWith({ type: "fetchPiiNerModel", text: "~/models/ner" })
	})

	it("書き込んだ辞書をそのまま送る（FR-PII-17a）", () => {
		renderWith({ terms: [{ value: "株式会社サンプル" }], dictionaryPaths: ["/w/team.txt"] })

		fireEvent.click(screen.getByTestId("pii-export"))

		expect(postMessage).toHaveBeenCalledWith({
			type: "exportPiiDictionary",
			values: { terms: [{ value: "株式会社サンプル" }], dictionaryPaths: ["/w/team.txt"] },
		})
	})
})

describe("区分を 1 つも選んでいない状態（FR-PII-21a）", () => {
	it("既定ではその注意を出さない", () => {
		renderWith({ properNouns: { enabled: true } })

		expect(screen.queryByTestId("pii-no-entities")).not.toBeInTheDocument()
	})

	it("全部外したら、1 件も伏せられないと出す", () => {
		// モデルの読み込みだけが行われ、入っているのに何も伏せない状態になる。
		// 伏せる種類の側（`pii-no-kinds`）と同じ扱いにする。
		renderWith({ properNouns: { enabled: true, entities: [] } })

		expect(screen.getByTestId("pii-no-entities")).toBeInTheDocument()
	})
})

describe("モデルの置き場所を画面へ出す（FR-PII-23a）", () => {
	/** 拡張から返ってきた体にする。 */
	const reply = (piiNerModel: unknown) =>
		fireEvent(window, new MessageEvent("message", { data: { type: "piiNerModelStatus", piiNerModel } }))

	it("描画したら、どこを見ているかを尋ねる", () => {
		renderWith({ properNouns: { enabled: true, modelPath: "~/models/ner" } })

		expect(postMessage).toHaveBeenCalledWith({ type: "requestPiiNerModelStatus", text: "~/models/ner" })
	})

	it("返ってきたら、場所と状態を出す", () => {
		// **場所を出さないと、閉鎖環境の利用者はどこへ運べばよいか分からない。**
		renderWith({ properNouns: { enabled: true } })

		reply({ directory: "/home/x/.agent/pii-ner", present: true, missing: [], bytes: 295_000_000 })

		const status = screen.getByTestId("pii-model-status")
		expect(status).toHaveTextContent("/home/x/.agent/pii-ner")
		expect(status).toHaveTextContent("settings:pii.properNouns.placed")
	})

	it("足りなければ、その旨を出す", () => {
		renderWith({ properNouns: { enabled: true } })

		reply({ directory: "/home/x/.agent/pii-ner", present: false, missing: ["SHA256SUMS", "config.json"], bytes: 0 })

		expect(screen.getByTestId("pii-model-status")).toHaveTextContent("settings:pii.properNouns.notPlaced")
	})

	it("返ってくるまでは何も出さない", () => {
		renderWith({ properNouns: { enabled: true } })

		expect(screen.queryByTestId("pii-model-status")).not.toBeInTheDocument()
	})
})
