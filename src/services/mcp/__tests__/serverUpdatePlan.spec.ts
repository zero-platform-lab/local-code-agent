import { describe, it, expect } from "vitest"

import { validateServerConfig } from "../serverConfigSchema"
import { planServerConnectionUpdates } from "../serverUpdatePlan"

const rawStdio = (extra: Record<string, unknown> = {}) => ({ type: "stdio", command: "node", args: [], ...extra })

const summarize = (actions: { kind: string; name: string }[]) => actions.map((a) => `${a.kind}:${a.name}`)

describe("planServerConnectionUpdates", () => {
	it("新しい設定から消えたサーバを toDelete に入れる", () => {
		const plan = planServerConnectionUpdates({ keep: rawStdio() }, ["keep", "gone1", "gone2"], () => ({
			declaredConfig: validateServerConfig(rawStdio(), "keep"),
		}))

		expect(plan.toDelete).toEqual(["gone1", "gone2"])
	})

	it("既存接続が無いサーバは connect", () => {
		const plan = planServerConnectionUpdates({ fresh: rawStdio() }, [], () => undefined)

		expect(summarize(plan.actions)).toEqual(["connect:fresh"])
	})

	it("宣言が変わった既存サーバは reconnect、変わらなければ何もしない", () => {
		const current = new Map([
			["keep", { declaredConfig: validateServerConfig(rawStdio(), "keep") }],
			["changed", { declaredConfig: validateServerConfig(rawStdio({ timeout: 30 }), "changed") }],
		])

		const plan = planServerConnectionUpdates(
			{ keep: rawStdio(), changed: rawStdio({ timeout: 99 }) },
			["keep", "changed"],
			(name) => current.get(name),
		)

		// keep は同一設定なので actions に現れない
		expect(summarize(plan.actions)).toEqual(["reconnect:changed"])
		expect(plan.toDelete).toEqual([])
	})

	it("検証に失敗する設定は invalid（エラーを載せてスキップ）", () => {
		const plan = planServerConnectionUpdates({ bad: {} }, [], () => undefined)

		expect(plan.actions).toHaveLength(1)
		expect(plan.actions[0]).toMatchObject({ kind: "invalid", name: "bad" })
		expect((plan.actions[0] as { error: unknown }).error).toBeDefined()
	})

	it("actions は設定ファイルの記述順を保つ（delete は分離）", () => {
		const current = new Map([["b", { declaredConfig: validateServerConfig(rawStdio({ timeout: 1 }), "b") }]])

		const plan = planServerConnectionUpdates(
			{ a: rawStdio(), b: rawStdio({ timeout: 2 }), c: {} },
			["b", "removed"],
			(name) => current.get(name),
		)

		expect(plan.toDelete).toEqual(["removed"])
		expect(summarize(plan.actions)).toEqual(["connect:a", "reconnect:b", "invalid:c"])
	})
})
