// npx vitest run core/webview/__tests__/buildState.mode.spec.ts
//
// 保存済み mode slug の解決。過去の組み込みモード（architect など）や、撤去済みの
// カスタムモード機構で作られた slug が globalState に残っていることがある。
// これを素通しすると isToolAllowedForMode の `if (!mode) return false` に落ち、
// 常時ツール以外がすべて拒否されてエージェントが何もできなくなる。

vi.mock("vscode")

import { buildState, type StateExtras } from "../buildState"
import { defaultModeSlug } from "../../../shared/modes"

const extras = (): StateExtras =>
	({
		apiConfiguration: {},
		taskHistory: [],
		mcpServers: [],
		organizationAllowList: undefined,
		lockApiConfigAcrossModes: false,
	}) as unknown as StateExtras

const modeOf = (saved: unknown) => buildState({ mode: saved } as never, extras()).mode

describe("buildState の mode 解決", () => {
	it("未設定なら既定モードになる", () => {
		expect(modeOf(undefined)).toBe(defaultModeSlug)
	})

	it("実在する組み込みモードはそのまま通す", () => {
		expect(modeOf("code")).toBe("code")
		expect(modeOf("research")).toBe("research")
	})

	it("削除された組み込みモードの slug は既定へ落とす", () => {
		// モード集約（#17〜#21）で消した 4 つ。globalState に残っていても復帰できること。
		for (const removed of ["architect", "ask", "debug", "orchestrator"]) {
			expect(modeOf(removed)).toBe(defaultModeSlug)
		}
	})

	it("撤去済みカスタムモード機構の slug も既定へ落とす", () => {
		expect(modeOf("deleted-custom-mode")).toBe(defaultModeSlug)
	})

	it("空文字は既定へ落とす", () => {
		expect(modeOf("")).toBe(defaultModeSlug)
	})
})
