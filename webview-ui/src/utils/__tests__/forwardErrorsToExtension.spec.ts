// npx vitest run src/utils/__tests__/forwardErrorsToExtension.spec.ts
//
// 白い画面の調査用に、Webview のエラーを拡張のログへ送る。送る文と、登録の解除を確かめる。

import {
	DIAGNOSTIC_MAX_LENGTH,
	describeErrorForExtension,
	forwardErrorsToExtension,
	reportWebviewDiagnostic,
} from "../forwardErrorsToExtension"

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock("../vscode", () => ({ vscode: { postMessage: (...args: unknown[]) => mocks.postMessage(...args) } }))

/** jsdom には PromiseRejectionEvent が無いので、同じ形の Event を作る。 */
function rejectionEvent(reason: unknown): Event {
	return Object.assign(new Event("unhandledrejection"), { reason })
}

beforeEach(() => {
	mocks.postMessage.mockClear()
})

describe("describeErrorForExtension", () => {
	it("Error はスタックを使う", () => {
		const error = new Error("boom")

		expect(describeErrorForExtension(error)).toBe(error.stack)
	})

	it("スタックの無い Error は message を使う", () => {
		const error = new Error("no stack")
		error.stack = undefined

		expect(describeErrorForExtension(error)).toBe("no stack")
	})

	it("Error 以外は文字列にする", () => {
		expect(describeErrorForExtension({ toString: () => "plain" })).toBe("plain")
	})

	it("上限ちょうどは切らず、1 文字でも超えたら切る", () => {
		expect(describeErrorForExtension("a".repeat(10), 10)).toBe("a".repeat(10))
		expect(describeErrorForExtension("a".repeat(11), 10)).toBe(`${"a".repeat(10)}… (truncated)`)
	})

	it("既定の上限は、届く長さのスタックで効く", () => {
		const text = describeErrorForExtension("x".repeat(DIAGNOSTIC_MAX_LENGTH + 1))

		expect(text).toBe(`${"x".repeat(DIAGNOSTIC_MAX_LENGTH)}… (truncated)`)
	})
})

describe("forwardErrorsToExtension", () => {
	it("error を送る。error が無ければ message を使う", () => {
		const target = new EventTarget() as Window
		forwardErrorsToExtension(target)

		target.dispatchEvent(new ErrorEvent("error", { message: "script error" }))

		expect(mocks.postMessage).toHaveBeenCalledWith({ type: "webviewDiagnostic", text: "error: script error" })
	})

	it("拒否された Promise の理由を送る", () => {
		const target = new EventTarget() as Window
		forwardErrorsToExtension(target)

		target.dispatchEvent(rejectionEvent("network down"))

		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "webviewDiagnostic",
			text: "unhandled rejection: network down",
		})
	})

	it("戻り値を呼ぶと、どちらのイベントも送らなくなる", () => {
		const target = new EventTarget() as Window
		const uninstall = forwardErrorsToExtension(target)

		uninstall()
		target.dispatchEvent(new ErrorEvent("error", { message: "late" }))
		target.dispatchEvent(rejectionEvent("late"))

		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("既定では window に登録する", () => {
		const uninstall = forwardErrorsToExtension()

		window.dispatchEvent(rejectionEvent("on window"))
		uninstall()

		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
	})
})

describe("reportWebviewDiagnostic", () => {
	it("webviewDiagnostic として送る", () => {
		reportWebviewDiagnostic("hello")

		expect(mocks.postMessage).toHaveBeenCalledWith({ type: "webviewDiagnostic", text: "hello" })
	})
})
