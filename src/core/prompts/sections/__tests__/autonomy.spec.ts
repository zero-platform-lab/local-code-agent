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

		it("todoListEnabled=false なら update_todo_list を指示せず、応答内に出す形に切り替える", () => {
			// update_todo_list は filter-tools-for-mode.ts で todoListEnabled=false のとき外れる。
			// 外れているのに使えと書くと、存在しないツールを呼ばせることになる。
			const withoutTodo = getAutonomySection("plan", false)

			expect(withoutTodo).not.toContain("update_todo_list")
			expect(withoutTodo).toContain("Present the plan directly in your response")
		})

		describe("architect からの移送", () => {
			it("計画の品質基準を引き継いでいる", () => {
				expect(section).toContain("Specific and actionable")
				expect(section).toContain("Listed in logical execution order")
			})

			it("Mermaid の推奨と記法の注意を引き継いでいる", () => {
				expect(section).toContain("Mermaid")
				expect(section).toContain("square brackets")
			})

			it("工数見積もりの禁止を引き継いでいる", () => {
				expect(section).toContain("Never give time or effort estimates")
			})

			it("switch_mode での移行要求は引き継がない（自律レベルはユーザーの専権）", () => {
				expect(section).not.toContain("switch_mode")
			})

			it("計画ファイルの書き出しは引き継がない（plan では edit が遮断されるため）", () => {
				// architect には /plans への保存と、update_todo_list 不在時に markdown へ
				// 書く代替があったが、どちらも plan では実行できない。
				for (const flag of [true, false]) {
					const text = getAutonomySection("plan", flag)

					expect(text).not.toContain("/plans")
					expect(text).not.toMatch(/write the plan to a markdown file/i)
				}
			})
		})

		it("MCP とサブタスクが遮断ではなく承認待ちであることを伝える", () => {
			// AUTONOMY_PRESETS.plan は alwaysAllowMcp / alwaysAllowSubtasks が false。
			// 一方 READ_ONLY_BLOCKED_GROUPS は edit / command だけなので、この 2 つは
			// 「使えるが毎回訊かれる」。遮断と混同させない。
			expect(section).toContain("MCP tools and subtasks are not blocked")
			expect(section).toContain("not auto-approved")
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

		it("plan で自動承認されないツール群は、文面でも承認が要ると伝える", () => {
			const preset = AUTONOMY_PRESETS.plan
			const section = getAutonomySection("plan")

			// 実際に false のものだけを検証する。プリセットを変えたらここで気づく。
			expect(preset.alwaysAllowMcp).toBe(false)
			expect(preset.alwaysAllowSubtasks).toBe(false)
			expect(section).toMatch(/approval/i)
		})

		it("読み取り専用モードだけが「試みても成功しない」と伝える", () => {
			for (const mode of autonomyModes) {
				const saysBlocked = getAutonomySection(mode).includes("cannot succeed")

				expect(saysBlocked).toBe(isReadOnlyAutonomyMode(mode))
			}
		})
	})
})
