// loadRequiredLanguageParsers / loadLanguage の catch 節（Parser.init 失敗・Language.load 失敗）と、
// そこでのエラー整形三項（error instanceof Error ? error.message : error）の両側を、
// 本物の wasm ランタイム/パースを起動せずに検証する。
//
// languageParser.ts は web-tree-sitter を動的 require で取得する（bundle 時評価回避のため）。
// これは外部 node_module なので vi.mock では差し替わらず、ESM import の名前空間とも別オブジェクト。
// そこで createRequire で「同じ CJS モジュールキャッシュ」の exports を取り、その Parser.init /
// Language.load を spyOn する。
//
// isParserInitialized はモジュール内 sticky 状態なので、テストごとに vi.resetModules() で
// languageParser を読み直し、毎回 false から始める（web-tree-sitter は外部キャッシュなので
// resetModules の影響を受けず spy は有効なまま）。
import { createRequire } from "module"

const requireCjs = createRequire(import.meta.url)
const webTreeSitter = requireCjs("web-tree-sitter") as {
	Parser: { init: (...a: unknown[]) => Promise<unknown> }
	Language: { load: (...a: unknown[]) => Promise<unknown> }
}

describe("languageParser: init / load 失敗の catch とエラー整形", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("Parser.init が Error で reject → console.error して rethrow（83-85 行, 84 の error.message 側）", async () => {
		const initSpy = vi.spyOn(webTreeSitter.Parser, "init").mockRejectedValue(new Error("init boom"))
		const loadSpy = vi.spyOn(webTreeSitter.Language, "load")
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { loadRequiredLanguageParsers } = await import("../languageParser")

		await expect(loadRequiredLanguageParsers(["sample.ts"], "/wasm/dir")).rejects.toThrow("init boom")
		expect(initSpy).toHaveBeenCalled()
		// init 失敗時は言語ロードまで到達しない
		expect(loadSpy).not.toHaveBeenCalled()
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error initializing parser: init boom"))
	})

	it("Parser.init が非 Error で reject → 三項の else 側（84 行の : error）", async () => {
		vi.spyOn(webTreeSitter.Parser, "init").mockRejectedValue("plain-init-failure")
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { loadRequiredLanguageParsers } = await import("../languageParser")

		await expect(loadRequiredLanguageParsers(["sample.ts"], "/wasm/dir")).rejects.toBe("plain-init-failure")
		// 非 Error はそのまま整形される
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error initializing parser: plain-init-failure"))
	})

	it("Language.load が非 Error で reject → loadLanguage catch の else 側（44 行の : error）", async () => {
		// init は成功させ（wasm ランタイムは起動しないモック）、言語ロードだけ失敗させる。
		vi.spyOn(webTreeSitter.Parser, "init").mockResolvedValue(undefined)
		vi.spyOn(webTreeSitter.Language, "load").mockRejectedValue("plain-load-failure")
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { loadRequiredLanguageParsers } = await import("../languageParser")

		await expect(loadRequiredLanguageParsers(["sample.ts"], "/wasm/dir")).rejects.toBe("plain-load-failure")
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error loading language"))
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("plain-load-failure"))
	})
})
