// npx vitest run core/webview/__tests__/buildState.mode.spec.ts
//
// 保存済み mode slug の解決。組み込みモードが code の 1 件に減ったため、過去に
// architect などへ切り替えたユーザーの globalState には存在しない slug が残る。
// これを素通しすると isToolAllowedForMode の `if (!mode) return false` に落ち、
// 常時ツール以外がすべて拒否されてエージェントが何もできなくなる。

vi.mock("vscode")

import type { ModeConfig } from "@openai-agent/types"

import { buildState, type StateExtras } from "../buildState"
import { defaultModeSlug } from "../../../shared/modes"
import { isToolAllowedForMode } from "../../tools/validateToolUse"

const extras = (customModes: ModeConfig[] = []): StateExtras =>
	({
		apiConfiguration: {},
		customModes,
		taskHistory: [],
		mcpServers: [],
		organizationAllowList: undefined,
		lockApiConfigAcrossModes: false,
	}) as unknown as StateExtras

const modeOf = (saved: unknown, customModes: ModeConfig[] = []) =>
	buildState({ mode: saved } as never, extras(customModes)).mode

describe("buildState の mode 解決", () => {
	it("未設定なら既定モードになる", () => {
		expect(modeOf(undefined)).toBe(defaultModeSlug)
	})

	it("実在する組み込みモードはそのまま通す", () => {
		expect(modeOf("code")).toBe("code")
	})

	it("削除された組み込みモードの slug は既定へ落とす", () => {
		// 3 手目で消した 4 つ。globalState に残っていても復帰できること。
		for (const removed of ["architect", "ask", "debug", "orchestrator"]) {
			expect(modeOf(removed)).toBe(defaultModeSlug)
		}
	})

	it("実在するカスタムモードは維持する", () => {
		const custom: ModeConfig = {
			slug: "my-mode",
			name: "My Mode",
			roleDefinition: "You do my work",
			groups: ["read"],
		}

		expect(modeOf("my-mode", [custom])).toBe("my-mode")
	})

	it("削除済みのカスタムモードの slug も既定へ落とす", () => {
		expect(modeOf("deleted-custom-mode", [])).toBe(defaultModeSlug)
	})

	it("空文字は既定へ落とす", () => {
		expect(modeOf("")).toBe(defaultModeSlug)
	})

	describe("customModes の読み込みに失敗しているとき", () => {
		// 読み込み失敗時は customModes が [] に落ちる。これを「そのモードは消えた」と
		// 解釈して既定へ倒すと、制限付きカスタムモードが code（read/edit/command/mcp）
		// へ黙って昇格する。設定ファイルが壊れているだけで権限が広がってはならない。
		const modeOnLoadFailure = (saved: unknown) =>
			buildState({ mode: saved } as never, {
				...extras([]),
				customModesLoadFailed: true,
			}).mode

		it("解決できない slug を既定へ落とさない（権限の昇格を防ぐ）", () => {
			expect(modeOnLoadFailure("my-restricted-mode")).toBe("my-restricted-mode")
		})

		it("落とさない結果ツールは拒否されるが、それが安全側", () => {
			// isToolAllowedForMode は解決できない mode に対して false を返す。
			// 利用者には YAML のエラー通知が出ているので、直せば復帰できる。
			expect(isToolAllowedForMode("write_to_file", modeOnLoadFailure("my-restricted-mode"), [])).toBe(false)
		})

		it("未設定なら読み込み失敗でも既定になる", () => {
			expect(modeOnLoadFailure(undefined)).toBe(defaultModeSlug)
		})

		it("読み込みが成功していれば従来どおり既定へ落とす", () => {
			expect(modeOf("my-restricted-mode")).toBe(defaultModeSlug)
		})
	})
})
