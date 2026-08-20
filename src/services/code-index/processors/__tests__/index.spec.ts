// npx vitest services/code-index/processors/__tests__/index.spec.ts
//
// processors/index.ts は再エクスポート専用のバレル。
// import して各シンボルが解決されることだけを確認し、命令網羅を満たす。

import * as processors from "../index"

describe("processors/index barrel", () => {
	it("re-exports parser / scanner / file-watcher の公開シンボル", () => {
		// バレルが読み込まれ、各モジュールのクラス/シングルトンが解決されること
		expect(processors.CodeParser).toBeDefined()
		expect(processors.codeParser).toBeDefined()
		expect(processors.DirectoryScanner).toBeDefined()
		expect(processors.FileWatcher).toBeDefined()
	})
})
