// npx vitest run core/prompts/sections/__tests__/autonomy.spec.ts
//
// 自律モードをモデルに伝えるセクション。承認ゲートと plan の遮断は実装上モデルから
// 見えないため、ここが文面として唯一の伝達経路になる。

import { autonomyModes, AUTONOMY_PRESETS, isReadOnlyAutonomyMode } from "@openai-agent/types"

import { getAutonomySection } from "../autonomy"

describe("getAutonomySection", () => {
	it("モード未指定なら空文字を返す（従来のプロンプトと一致させるため）", () => {
		expect(getAutonomySection(undefined)).toBe("")
	})

	it.each(autonomyModes)("%s の文面を返し、セクション見出しを持つ", (mode) => {
		const section = getAutonomySection(mode)

		expect(section).toContain("====")
		expect(section).toContain("AUTONOMY MODE")
		expect(section.trim().length).toBeGreaterThan(0)
	})

	it("全モードで互いに異なる文面になる（取り違えの検出）", () => {
		const sections = autonomyModes.map((mode) => getAutonomySection(mode))

		expect(new Set(sections).size).toBe(autonomyModes.length)
	})

	describe("plan", () => {
		const section = getAutonomySection("plan")

		it("読み取り専用であることと、編集・コマンドが実行前に拒否されることを伝える", () => {
			expect(section).toContain("read-only")
			expect(section).toContain("rejected by the tool-validation layer")
		})

		it("計画の記録先として update_todo_list を指示する", () => {
			expect(section).toContain("update_todo_list")
		})

		it("モデル自身が自律レベルを上げようとしないよう明記する", () => {
			// autonomy.ts の "autonomy is user-controlled ONLY" と対になる文面。
			expect(section).toContain("the user's decision alone")
		})
	})

	describe("プリセットとの整合", () => {
		it("コマンド実行を自動化しないモードは、承認が要ることを文面でも伝える", () => {
			for (const mode of autonomyModes) {
				if (AUTONOMY_PRESETS[mode].alwaysAllowExecute) {
					continue
				}

				const section = getAutonomySection(mode)
				const mentionsGate = /approval|approve|rejected/i.test(section)

				expect(mentionsGate).toBe(true)
			}
		})

		it("読み取り専用モードだけが「試みても成功しない」と伝える", () => {
			for (const mode of autonomyModes) {
				const saysBlocked = getAutonomySection(mode).includes("cannot succeed")

				expect(saysBlocked).toBe(isReadOnlyAutonomyMode(mode))
			}
		})
	})
})
