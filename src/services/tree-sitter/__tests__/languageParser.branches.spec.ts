// loadRequiredLanguageParsers / loadLanguage の「wasm ロード失敗」系と __dirname 既定分岐を、
// 本物の重い wasm パースを走らせずに検証する。
//
// ここでは web-tree-sitter 自体はモックせず、存在しない wasm パスを渡して Language.load を
// 自然に失敗させる。これで loadLanguage の catch（console.error + rethrow）と、
// sourceDirectory 未指定時の __dirname 既定分岐の両方を、実ファイル I/O だけで到達させる。
// （Parser.init 失敗系は状態が sticky なため別ファイルでモックして検証する。）

describe("languageParser: wasm ロード失敗と __dirname 既定分岐", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("存在しない wasm ディレクトリを渡すと console.error して rethrow する（43-46 行）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { loadRequiredLanguageParsers } = await import("../languageParser")

		await expect(loadRequiredLanguageParsers(["sample.ts"], "/definitely/not/here")).rejects.toBeInstanceOf(Error)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error loading language"))
		// ロード先が渡した sourceDirectory 配下の wasm であることも確認
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("/definitely/not/here"))
	})

	it("sourceDirectory 未指定なら __dirname 基準で wasm を解決する（34 行の既定分岐）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { loadRequiredLanguageParsers } = await import("../languageParser")

		// __dirname（= services/tree-sitter 直下）には wasm が無いのでロードは失敗するが、
		// 目的は「sourceDirectory || __dirname」の右辺を通すこと。
		await expect(loadRequiredLanguageParsers(["sample.ts"])).rejects.toBeInstanceOf(Error)
		// __dirname 由来のパスで typescript の wasm を読もうとした痕跡を確認
		const loggedPaths = errSpy.mock.calls.map((c) => String(c[0]))
		expect(loggedPaths.some((m) => m.includes("tree-sitter-typescript.wasm"))).toBe(true)
		// カスタム sourceDirectory を渡していないので、前テストのパスは含まれない
		expect(loggedPaths.some((m) => m.includes("/definitely/not/here"))).toBe(false)
	})
})
