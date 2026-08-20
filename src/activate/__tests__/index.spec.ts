// npx vitest run activate/__tests__/index.spec.ts
//
// バレル（index.ts）の唯一の責務は「4 つのシンボルを正しく再エクスポートする」こと。
// 各サブモジュールをセンチネルに差し替え、index 経由で同一物が出てくるかだけを固定する。

import { describe, it, expect, vi } from "vitest"

const sentinels = vi.hoisted(() => ({
	registerCommands: function registerCommands() {},
	registerCodeActions: function registerCodeActions() {},
	registerTerminalActions: function registerTerminalActions() {},
	CodeActionProvider: class CodeActionProvider {},
}))

vi.mock("../registerCommands", () => ({ registerCommands: sentinels.registerCommands }))
vi.mock("../registerCodeActions", () => ({ registerCodeActions: sentinels.registerCodeActions }))
vi.mock("../registerTerminalActions", () => ({ registerTerminalActions: sentinels.registerTerminalActions }))
vi.mock("../CodeActionProvider", () => ({ CodeActionProvider: sentinels.CodeActionProvider }))

import * as barrel from "../index"

describe("activate/index バレル", () => {
	it("4 つのシンボルを元実装のまま再エクスポートする", () => {
		expect(barrel.registerCommands).toBe(sentinels.registerCommands)
		expect(barrel.registerCodeActions).toBe(sentinels.registerCodeActions)
		expect(barrel.registerTerminalActions).toBe(sentinels.registerTerminalActions)
		expect(barrel.CodeActionProvider).toBe(sentinels.CodeActionProvider)
	})

	it("余計なシンボルを増やしていない", () => {
		expect(Object.keys(barrel).sort()).toEqual(
			["CodeActionProvider", "registerCodeActions", "registerCommands", "registerTerminalActions"].sort(),
		)
	})
})
