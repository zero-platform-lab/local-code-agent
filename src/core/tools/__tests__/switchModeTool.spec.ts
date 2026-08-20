// npx vitest run core/tools/__tests__/switchModeTool.spec.ts
//
// switch_mode は **エージェントの権限セット（使えるツール群）を切り替える**ツール。
// ここで守る不変条件は「未知／不正なモードへは絶対に切り替えない」こと。
// getModeBySlug が見つけられないモード、既に居るモード、承認されなかった場合に
// handleModeSwitch が呼ばれないことを固定する。切り替えが起きると以降のツール実行の
// 権限が変わってしまうため、承認前の副作用は事故に直結する。

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ModeConfig } from "@openai-agent/types"

import { switchModeTool } from "../SwitchModeTool"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import type { ToolUse } from "../../../shared/tools"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

// delay は 500ms 待つだけなのでテストでは即解決に差し替える（本題は切り替え判定）。
vi.mock("delay", () => ({ default: vi.fn(() => Promise.resolve()) }))

describe("switchModeTool", () => {
	let mockTask: any
	let mockCallbacks: any
	let handleModeSwitch: ReturnType<typeof vi.fn>

	/** provider の deref を { getState, handleModeSwitch } に差し替える。 */
	function useProvider(state: { customModes?: ModeConfig[]; mode?: string }) {
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(state),
			handleModeSwitch,
		})
	}

	function block(mode_slug: string, reason = ""): ToolUse<"switch_mode"> {
		return {
			type: "tool_use" as const,
			name: "switch_mode" as const,
			params: {},
			partial: false,
			nativeArgs: { mode_slug, reason },
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		mockTask = makeMockTask() as any
		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	describe("入力の検証", () => {
		it("mode_slug が空なら切り替えず、欠落エラーを返す", async () => {
			useProvider({ mode: "code" })

			await switchModeTool.handle(mockTask as Task, block(""), mockCallbacks)

			expect(handleModeSwitch).not.toHaveBeenCalled()
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
			expect(mockTask.mistakeTracker.count).toBe(1)
			expect(mockTask.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("switch_mode")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("switch_mode", "mode_slug")
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
		})
	})

	describe("不変条件：未知／不正なモードへは切り替えない", () => {
		it("存在しない slug では handleModeSwitch を呼ばず Invalid mode を返す", async () => {
			useProvider({ mode: "code", customModes: undefined })

			await switchModeTool.handle(mockTask as Task, block("does-not-exist", "理由"), mockCallbacks)

			expect(handleModeSwitch).not.toHaveBeenCalled()
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
			expect(mockTask.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("switch_mode")
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError("Invalid mode: does-not-exist"),
			)
		})

		it("既に同じモードなら切り替えず Already in を返す", async () => {
			useProvider({ mode: "architect" })

			await switchModeTool.handle(mockTask as Task, block("architect"), mockCallbacks)

			expect(handleModeSwitch).not.toHaveBeenCalled()
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
			expect(mockTask.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("switch_mode")
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Already in 🏗️ Architect mode.")
		})

		it("承認されなければ切り替えず、結果も出さない", async () => {
			useProvider({ mode: "code" })
			mockCallbacks.askApproval.mockResolvedValue(false)

			await switchModeTool.handle(mockTask as Task, block("architect", "設計に入る"), mockCallbacks)

			expect(handleModeSwitch).not.toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("承認後の切り替え", () => {
		it("承認されたら handleModeSwitch を呼び、理由付きの成功文を返す", async () => {
			useProvider({ mode: "code" })
			mockTask.mistakeTracker.count = 4

			await switchModeTool.handle(mockTask as Task, block("architect", "設計に入る"), mockCallbacks)

			expect(handleModeSwitch).toHaveBeenCalledWith("architect")
			// 承認を通った時点でミスカウントはリセットされている。
			expect(mockTask.mistakeTracker.count).toBe(0)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Successfully switched from 💻 Code mode to 🏗️ Architect mode because: 設計に入る.",
			)
		})

		it("理由が空なら because 句を付けない", async () => {
			useProvider({ mode: "code" })

			await switchModeTool.handle(mockTask as Task, block("architect", ""), mockCallbacks)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Successfully switched from 💻 Code mode to 🏗️ Architect mode.",
			)
		})

		it("state.mode が無ければ現在モードは既定（code）として扱う", async () => {
			// getState().mode 欠落は初期化直後などに起こりうる。defaultModeSlug に落ちる。
			useProvider({})

			await switchModeTool.handle(mockTask as Task, block("architect"), mockCallbacks)

			expect(handleModeSwitch).toHaveBeenCalledWith("architect")
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Successfully switched from 💻 Code mode to 🏗️ Architect mode.",
			)
		})

		it("現在モードが組み込みに無い slug でも生の slug で表示して切り替える", async () => {
			// カスタムモードへ切り替える際、現在モード名が組み込みに無いと
			// getModeBySlug(currentMode) は undefined。ここで生 slug に落ちることを固定。
			const customModes: ModeConfig[] = [
				{ slug: "wizard", name: "Wizard", roleDefinition: "r", groups: [] } as ModeConfig,
			]
			useProvider({ mode: "legacy-mode", customModes })

			await switchModeTool.handle(mockTask as Task, block("wizard"), mockCallbacks)

			expect(handleModeSwitch).toHaveBeenCalledWith("wizard")
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Successfully switched from legacy-mode mode to Wizard mode.",
			)
		})

		it("provider 参照が切れていても組み込みモードなら既定現在モードで切り替える", async () => {
			// deref() が undefined を返す（webview 破棄後など）。落ちずに既定 code から切り替える。
			mockTask.providerRef.deref = vi.fn().mockReturnValue(undefined)

			await switchModeTool.handle(mockTask as Task, block("architect", "続行"), mockCallbacks)

			// handleModeSwitch は deref?.() 経由なので呼ばれないが、クラッシュせず成功文を出す。
			expect(mockCallbacks.handleError).not.toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Successfully switched from 💻 Code mode to 🏗️ Architect mode because: 続行.",
			)
		})
	})

	describe("例外処理", () => {
		it("途中で例外が出たら handleError に委譲する", async () => {
			useProvider({ mode: "code" })
			const boom = new Error("approval boom")
			mockCallbacks.askApproval.mockRejectedValue(boom)

			await switchModeTool.handle(mockTask as Task, block("architect"), mockCallbacks)

			expect(mockCallbacks.handleError).toHaveBeenCalledWith("switching mode", boom)
			expect(handleModeSwitch).not.toHaveBeenCalled()
		})
	})

	describe("handlePartial", () => {
		it("mode_slug と reason をそのまま streaming 表示に載せる", async () => {
			const partial: ToolUse<"switch_mode"> = {
				type: "tool_use",
				name: "switch_mode",
				params: { mode_slug: "architect", reason: "設計" },
				partial: true,
			}

			await switchModeTool.handle(mockTask as Task, partial, mockCallbacks)

			expect(mockTask.ask).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "switchMode", mode: "architect", reason: "設計" }),
				true,
			)
		})

		it("mode_slug / reason が未定義でも空文字で表示する（生 JSON を出さない）", async () => {
			const partial: ToolUse<"switch_mode"> = {
				type: "tool_use",
				name: "switch_mode",
				params: {},
				partial: true,
			}

			await switchModeTool.handle(mockTask as Task, partial, mockCallbacks)

			expect(mockTask.ask).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "switchMode", mode: "", reason: "" }),
				true,
			)
		})
	})
})
