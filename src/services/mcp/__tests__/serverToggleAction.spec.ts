import { describe, it, expect } from "vitest"

import type { McpServer } from "@openai-agent/types"

import { resolveServerToggleAction } from "../serverToggleAction"

type Status = McpServer["status"]

describe("resolveServerToggleAction", () => {
	describe("無効化するとき", () => {
		it("稼働中なら止めて placeholder に置き換える", () => {
			expect(resolveServerToggleAction(true, "connected")).toBe("reconnect-as-disabled")
		})

		it("既に止まっていれば何もしない", () => {
			expect(resolveServerToggleAction(true, "disconnected")).toBe("none")
		})

		it("接続中（connecting）なら何もしない", () => {
			expect(resolveServerToggleAction(true, "connecting")).toBe("none")
		})
	})

	describe("有効化するとき", () => {
		it("止まっていれば繋ぎ直す", () => {
			expect(resolveServerToggleAction(false, "disconnected")).toBe("reconnect-as-enabled")
		})

		it("既に繋がっていれば設定反映のため一覧だけ取り直す", () => {
			expect(resolveServerToggleAction(false, "connected")).toBe("refresh-capabilities")
		})

		it("接続中（connecting）なら何もしない（接続完了を待つ）", () => {
			expect(resolveServerToggleAction(false, "connecting")).toBe("none")
		})
	})

	it("全ての (disabled, status) 組み合わせを網羅している", () => {
		const statuses: Status[] = ["connected", "connecting", "disconnected"]
		const table = statuses.flatMap((status) =>
			[true, false].map((disabled) => [disabled, status, resolveServerToggleAction(disabled, status)]),
		)

		expect(table).toEqual([
			[true, "connected", "reconnect-as-disabled"],
			[false, "connected", "refresh-capabilities"],
			[true, "connecting", "none"],
			[false, "connecting", "none"],
			[true, "disconnected", "none"],
			[false, "disconnected", "reconnect-as-enabled"],
		])
	})
})
