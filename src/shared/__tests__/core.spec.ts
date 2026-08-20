// npx vitest run shared/__tests__/core.spec.ts

import * as core from "../core"

// core.ts は @openai-agent/core/browser を再エクスポートするだけのバレル。
// import して再エクスポート文（実行文）が評価されることを確認する。
describe("core barrel", () => {
	it("再エクスポートを名前空間として読み込める", () => {
		expect(typeof core).toBe("object")
		expect(core).not.toBeNull()
	})
})
