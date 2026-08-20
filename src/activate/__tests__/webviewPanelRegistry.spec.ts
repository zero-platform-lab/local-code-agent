// npx vitest run activate/__tests__/webviewPanelRegistry.spec.ts
//
// パネルレジストリはモジュールレベルの単一状態（sidebar / tab）を持つ小さなリーフ。
// 不変条件:
//   - 同時に生きるのは片方だけ。一方を set するともう一方は必ず undefined になる
//   - getPanel は tab を sidebar より優先する
// 状態がテスト間で漏れないよう、各テストでモジュールを読み直す。

import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("vscode", () => ({}))

type Registry = typeof import("../webviewPanelRegistry")

let reg: Registry

beforeEach(async () => {
	vi.resetModules()
	reg = await import("../webviewPanelRegistry")
})

describe("webviewPanelRegistry", () => {
	it("初期状態はすべて undefined", () => {
		expect(reg.getPanel()).toBeUndefined()
		expect(reg.getTabPanel()).toBeUndefined()
		expect(reg.getSidebarPanel()).toBeUndefined()
	})

	it("sidebar を設定すると sidebar だけが生き、tab は消える", () => {
		const tab = { kind: "tab" } as never
		reg.setPanel(tab, "tab")
		expect(reg.getTabPanel()).toBe(tab)

		const sidebar = { kind: "sidebar" } as never
		reg.setPanel(sidebar, "sidebar")

		expect(reg.getSidebarPanel()).toBe(sidebar)
		expect(reg.getTabPanel()).toBeUndefined()
	})

	it("tab を設定すると tab だけが生き、sidebar は消える", () => {
		const sidebar = { kind: "sidebar" } as never
		reg.setPanel(sidebar, "sidebar")
		expect(reg.getSidebarPanel()).toBe(sidebar)

		const tab = { kind: "tab" } as never
		reg.setPanel(tab, "tab")

		expect(reg.getTabPanel()).toBe(tab)
		expect(reg.getSidebarPanel()).toBeUndefined()
	})

	it("getPanel は tab を sidebar より優先する", () => {
		const sidebar = { kind: "sidebar" } as never
		reg.setPanel(sidebar, "sidebar")
		expect(reg.getPanel()).toBe(sidebar)

		const tab = { kind: "tab" } as never
		reg.setPanel(tab, "tab")
		expect(reg.getPanel()).toBe(tab)
	})

	it("undefined を set すれば参照が外れる", () => {
		reg.setPanel({ kind: "tab" } as never, "tab")
		reg.setPanel(undefined, "tab")
		expect(reg.getTabPanel()).toBeUndefined()
		expect(reg.getPanel()).toBeUndefined()
	})
})
