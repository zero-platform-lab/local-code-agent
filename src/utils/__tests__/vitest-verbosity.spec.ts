// npx vitest run utils/__tests__/vitest-verbosity.spec.ts

import { describe, it, expect } from "vitest"

import { resolveVerbosity } from "../vitest-verbosity"

describe("resolveVerbosity", () => {
	it("引数なしなら silent かつ dot レポーターのみ", () => {
		const { silent, reporters } = resolveVerbosity([])
		expect(silent).toBe(true)
		expect(reporters).toEqual(["dot"])
	})

	it("--no-silent で silent を解除する", () => {
		expect(resolveVerbosity(["--no-silent"]).silent).toBe(false)
	})

	it("--silent=false でも silent を解除する", () => {
		expect(resolveVerbosity(["--silent=false"]).silent).toBe(false)
	})

	it.each([["--reporter=verbose"], ["-r=verbose"], ["--reporter"]])(
		"%s を渡すと verbose レポーターを追加する",
		(flag) => {
			expect(resolveVerbosity([flag]).reporters).toEqual(["dot", "verbose"])
		},
	)

	describe("onConsoleLog", () => {
		it("silent 時は stdout の log を落とす（false を返す）", () => {
			const { onConsoleLog } = resolveVerbosity([])
			expect(onConsoleLog("noise", "stdout")).toBe(false)
		})

		it("silent 時でも stderr は通す（undefined を返す）", () => {
			const { onConsoleLog } = resolveVerbosity([])
			expect(onConsoleLog("boom", "stderr")).toBeUndefined()
		})

		it("非 silent 時は stdout も通す（undefined を返す）", () => {
			const { onConsoleLog } = resolveVerbosity(["--no-silent"])
			expect(onConsoleLog("info", "stdout")).toBeUndefined()
		})
	})

	it("既定引数は process.argv を使う（呼び出しても落ちない）", () => {
		// 実行時の argv 依存を固定はしないが、既定パラメータ経路が評価されることを保証する。
		const result = resolveVerbosity()
		expect(Array.isArray(result.reporters)).toBe(true)
		expect(typeof result.silent).toBe("boolean")
	})
})
