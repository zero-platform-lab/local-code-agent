// npx vitest run core/webview/__tests__/WebviewContentGenerator.spec.ts
//
// 開発時（HMR）に Vite サーバーの起動を確かめる処理。axios から fetch へ置き換えたので、
// 「2xx 以外は起動していない扱い」という axios の振る舞いを fetch でも保っていることを固定する。
// fetch は 4xx・5xx でも投げないため、ここを落とすと 404 を返す別のサーバーを HMR と取り違える。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mocks = vi.hoisted(() => ({
	showErrorMessage: vi.fn(),
	existsSync: vi.fn((_p: string) => false),
	readFileSync: vi.fn((_p: string, _enc: string) => ""),
}))

vi.mock("fs", () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }))

vi.mock("vscode", () => ({
	window: { showErrorMessage: mocks.showErrorMessage },
	Uri: {
		joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
	},
}))

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { WebviewContentGenerator } from "../WebviewContentGenerator"

const webview = {
	asWebviewUri: (uri: { fsPath: string }) => `webview:${uri.fsPath}`,
	cspSource: "vscode-webview:",
} as never

const HMR_SCRIPT = "http://localhost:5173/src/index.tsx"

describe("WebviewContentGenerator.getHMRHtmlContent", () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		vi.stubGlobal("fetch", fetchMock)
		mocks.showErrorMessage.mockReset()
		mocks.existsSync.mockReset().mockReturnValue(false)
		mocks.readFileSync.mockReset()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		fetchMock.mockReset()
	})

	const generate = () => new WebviewContentGenerator({ fsPath: "/ext" } as never).getHMRHtmlContent(webview)

	it("Vite サーバーが 2xx を返せば、HMR の HTML を返す", async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 })

		const html = await generate()

		expect(fetchMock).toHaveBeenCalledWith("http://localhost:5173")
		expect(html).toContain(HMR_SCRIPT)
		expect(mocks.showErrorMessage).not.toHaveBeenCalled()
	})

	it("2xx 以外（404）なら、起動していない扱いでビルド済みの HTML に戻す", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 })

		const html = await generate()

		expect(html).not.toContain(HMR_SCRIPT)
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.hmr_not_running")
	})

	it("Vite のポートのファイルがあれば、そのポートへ確かめに行く", async () => {
		mocks.existsSync.mockReturnValue(true)
		mocks.readFileSync.mockReturnValue(" 6001\n")
		fetchMock.mockResolvedValue({ ok: true, status: 200 })

		const html = await generate()

		expect(fetchMock).toHaveBeenCalledWith("http://localhost:6001")
		expect(html).toContain("http://localhost:6001/src/index.tsx")
	})

	it("ポートのファイルを読めなければ、既定のポートで確かめる", async () => {
		mocks.existsSync.mockReturnValue(true)
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("EACCES")
		})
		fetchMock.mockResolvedValue({ ok: true, status: 200 })

		await generate()

		expect(fetchMock).toHaveBeenCalledWith("http://localhost:5173")
		expect(console.error).toHaveBeenCalled()
	})

	it("接続できなければ、ビルド済みの HTML に戻す", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"))

		const html = await generate()

		expect(html).not.toContain(HMR_SCRIPT)
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("common:errors.hmr_not_running")
	})
})
