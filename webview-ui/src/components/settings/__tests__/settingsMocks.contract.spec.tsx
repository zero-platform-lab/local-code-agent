// npx vitest run src/components/settings/__tests__/settingsMocks.contract.spec.tsx
//
// 設定画面の spec は `@vscode/webview-ui-toolkit/react` と `vscrui` を各ファイルで
// モックしている。VSCodeTextField は web component で value のセッターを持たず、
// fireEvent が値を差し込めないためで、これは避けられない。
//
// 避けられないぶん、モックが本物とずれると危ない。ずれたモックは本物より寛容に
// なりがちで、画面が直っていないのにテストだけ緑になる。このファイルだけはモック
// せず本物を描画し、**各 spec のモックが肩代わりしている約束**を固定する。
// ここが赤くなったら、直すのはこのファイルではなく各 spec のモックのほう。

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Checkbox } from "vscrui"

import { inputEventTransform } from "../transforms"

describe("VSCodeTextField（本物）", () => {
	it("onInput は target.value を持つ event を渡す", () => {
		// ProxySettingsControl は onInput の値を inputEventTransform で取り出す。
		// 本物の event がこの形でなくなると、URL 欄の入力が読めなくなる。
		let seen: unknown = null
		render(<VSCodeTextField value="a" onInput={(event: unknown) => (seen = event)} data-testid="tf" />)

		const host = screen.getByTestId("tf") as HTMLInputElement
		host.value = "socks5://127.0.0.1:1080"
		fireEvent.input(host)

		expect(inputEventTransform(seen)).toBe("socks5://127.0.0.1:1080")
	})

	it("disabled は属性ではなくプロパティで持つ", () => {
		render(<VSCodeTextField value="a" disabled={true} data-testid="tf" />)

		const host = screen.getByTestId("tf")
		// 本物は無効化を受け取っている（内側の proxy input に伝わる）。
		expect((host as unknown as { disabled: boolean }).disabled).toBe(true)
		expect(host.querySelector("input")).toBeDisabled()
		// ただしホスト要素には disabled 属性が付かない。各 spec が
		// `toBeDisabled()` を使えるのは、モックが素の input に置き換えているから。
		expect(host).not.toHaveAttribute("disabled")
	})

	it("data-testid はホスト要素に付き、children はラベルになる", () => {
		render(
			<VSCodeTextField value="a" data-testid="tf">
				URL
			</VSCodeTextField>,
		)

		expect(screen.getByTestId("tf")).toHaveTextContent("URL")
	})
})

describe("vscrui Checkbox（本物）", () => {
	it("onChange は event ではなく boolean を渡す", () => {
		// ProxySettingsControl の handleToggle は boolean を前提に 3 状態を決める。
		// ここが event になると常に真になり、OFF に戻せなくなる。
		let seen: unknown = "（呼ばれず）"
		render(
			<Checkbox checked={false} onChange={(value: unknown) => (seen = value)} data-testid="cb">
				proxy を使う
			</Checkbox>,
		)

		fireEvent.click(screen.getByTestId("cb").querySelector("input")!)

		expect(seen).toBe(true)
	})

	it("data-testid は label に付き、checked は内側の input が持つ", () => {
		render(
			<Checkbox checked={true} onChange={() => {}} data-testid="cb">
				proxy を使う
			</Checkbox>,
		)

		const label = screen.getByTestId("cb")
		expect(label.tagName).toBe("LABEL")
		expect(label.querySelector("input")).toBeChecked()
	})
})
