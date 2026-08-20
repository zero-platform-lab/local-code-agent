// npx vitest run core/assistant-message/__tests__/presentToolUse.spec.ts
//
// presentToolUse は native の `tool_use` ブロックを「検証 → 承認 → 実ツールへ委譲」する経路。
// 実ツール（toolDispatch 配下）は一切起動せず、presentToolUse が組み立てるコールバックと
// ゲート判定だけを固定する。ここで守る不変条件:
//   1. **利用者が拒否したらツールは 1 度も dispatch されない**（ExecuteCommandTool.invariants と同形）
//   2. native プロトコルの約束: tool_use には必ず tool_result を 1 つだけ返す
//      （id 欠落・拒否・nativeArgs 欠落・検証失敗・繰り返し・未知ツールのどれでも欠けない/重複しない）
//   3. 承認コメントは別 tool_result にせず実際の結果へマージする
//   4. パース/検証で壊れた入力でも throw で落とさない（best-effort の記録失敗も握りつぶす）
//   5. ファイルを書き換える tool の前だけ checkpoint を取る
//
// toolDispatch / validateToolUse / describeToolUse / i18n は贋物に差し替える。

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ToolUse } from "../../../shared/tools"

import { AskIgnoredError } from "../../task/AskIgnoredError"

// --- モック定義 -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	toolDispatch: {} as Record<string, unknown>,
	validateToolUse: vi.fn((..._a: unknown[]) => undefined),
	isValidToolName: vi.fn((..._a: unknown[]) => true),
}))

vi.mock("../toolDispatch", () => ({ toolDispatch: mocks.toolDispatch }))

vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: mocks.validateToolUse,
	isValidToolName: mocks.isValidToolName,
}))

vi.mock("../describeToolUse", () => ({ describeToolUse: vi.fn(() => "[read_file for 'a.ts']") }))

vi.mock("../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}(${JSON.stringify(args)})` : key),
}))

import { presentToolUse } from "../presentToolUse"

// --- テスト用ヘルパ ---------------------------------------------------------

interface HostOptions {
	didRejectTool?: boolean
	didCheckpoint?: boolean
	noProvider?: boolean
	state?: Record<string, unknown>
	modelInfo?: Record<string, unknown>
	askResponse?: { response: string; text?: string; images?: string[] }
	repetition?: { allowExecution: boolean; askUser?: { messageKey: string; messageDetail: string } }
	checkpointSave?: (...args: unknown[]) => Promise<unknown>
}

function makeHost(options: HostOptions = {}) {
	const provider = {
		getState: vi.fn(async () => options.state ?? { mode: "code", customModes: [] }),
	}

	const cline = {
		taskId: "task-1",
		instanceId: "inst-1",
		stream: {
			userMessageContent: [] as unknown[],
			didAlreadyUseTool: false,
			didRejectTool: options.didRejectTool ?? false,
			currentStreamingDidCheckpoint: options.didCheckpoint ?? false,
		},
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolUsage: vi.fn(), recordToolError: vi.fn() },
		toolRepetitionDetector: {
			check: vi.fn((..._a: unknown[]) => options.repetition ?? { allowExecution: true }),
		},
		pushToolResultToUserContent: vi.fn((..._a: unknown[]) => true),
		providerRef: { deref: vi.fn(() => (options.noProvider ? undefined : provider)) },
		api: { getModel: vi.fn(() => ({ id: "m", info: options.modelInfo ?? {} })) },
		ask: vi.fn(async (..._a: unknown[]) => options.askResponse ?? { response: "yesButtonClicked" }),
		say: vi.fn(async (..._a: unknown[]) => undefined),
		checkpointSave: vi.fn(options.checkpointSave ?? (async (..._a: unknown[]) => undefined)),
	}

	return { cline, provider }
}

function makeBlock(overrides: Partial<ToolUse> & { id?: string } = {}): ToolUse {
	return {
		type: "tool_use",
		id: "call_1",
		name: "read_file",
		params: { path: "a.ts" },
		partial: false,
		nativeArgs: { path: "a.ts" },
		...overrides,
	} as ToolUse
}

function results(cline: ReturnType<typeof makeHost>["cline"]) {
	return cline.pushToolResultToUserContent.mock.calls.map(([r]) => r as Record<string, unknown>)
}

/** dispatch エントリを登録し、handle が受け取ったコールバック群を取り出す。 */
async function captureCallbacks(cline: unknown, block: ToolUse, entryOverrides: Record<string, unknown> = {}) {
	let captured: any
	const handle = vi.fn(async (_task: unknown, _b: unknown, cb: unknown) => {
		captured = cb
	})
	mocks.toolDispatch[block.name] = { handle, ...entryOverrides }

	await presentToolUse(cline as never, block)

	return { ...(captured ?? {}), handle } as {
		askApproval: (...args: any[]) => Promise<boolean>
		handleError: (action: string, error: Error) => Promise<void>
		pushToolResult: (content: any, images?: string[]) => void
		askFinishSubTaskApproval?: () => Promise<boolean>
		toolDescription?: () => string
		handle: ReturnType<typeof vi.fn>
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	for (const key of Object.keys(mocks.toolDispatch)) {
		delete mocks.toolDispatch[key]
	}
	mocks.validateToolUse.mockReset()
	mocks.validateToolUse.mockImplementation((..._a: unknown[]) => undefined)
	mocks.isValidToolName.mockReset()
	mocks.isValidToolName.mockImplementation((..._a: unknown[]) => true)
})

// --- 1. id 欠落（XML 由来の無効呼び出し） -----------------------------------

describe("presentToolUse - tool_use.id が無い", () => {
	it("実行せず error を出し、以降の tool をスキップさせる", async () => {
		const { cline } = makeHost()
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock({ id: undefined }))

		expect(cline.say).toHaveBeenCalledWith("error", expect.stringContaining("missing tool_use.id"))
		expect(cline.stream.userMessageContent.some((b) => (b as { type: string }).type === "text")).toBe(true)
		expect(cline.stream.didAlreadyUseTool).toBe(true)
		expect(cline.mistakeTracker.count).toBe(1)
		expect(cline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("missing tool_use.id"),
		)
		expect(handle).not.toHaveBeenCalled()
	})

	it("記録用の recordToolError が投げても握りつぶして続行する", async () => {
		const { cline } = makeHost()
		cline.tokenUsageTracker.recordToolError = vi.fn(() => {
			throw new Error("boom")
		})

		await presentToolUse(cline as never, makeBlock({ id: undefined }))

		expect(cline.stream.didAlreadyUseTool).toBe(true)
		expect(cline.say).toHaveBeenCalledWith("error", expect.stringContaining("missing tool_use.id"))
	})
})

// --- 2. 直前のツールが拒否済み ----------------------------------------------

describe("presentToolUse - 直前のツールが拒否済み", () => {
	it("**dispatch せず** skip の tool_result をちょうど 1 件返す", async () => {
		const { cline } = makeHost({ didRejectTool: true })
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock({ id: "call:x/y" }))

		expect(handle).not.toHaveBeenCalled()
		expect(results(cline)).toEqual([
			{
				type: "tool_result",
				tool_use_id: "call_x_y", // サニタイズされる
				content: "Skipping tool [read_file for 'a.ts'] due to user rejecting a previous tool.",
				is_error: true,
			},
		])
	})

	it("ストリーミング途中なら「中断された」旨のメッセージにする", async () => {
		const { cline } = makeHost({ didRejectTool: true })

		await presentToolUse(cline as never, makeBlock({ partial: true }))

		expect(String(results(cline)[0].content)).toContain("was interrupted and not executed")
	})
})

// --- 3. nativeArgs 欠落 ------------------------------------------------------

describe("presentToolUse - 既知ツールなのに nativeArgs が無い", () => {
	it("実行せず error 結果を返す（didAlreadyUseTool は立てない）", async () => {
		const { cline } = makeHost()
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock({ nativeArgs: undefined }))

		expect(String(results(cline)[0].content)).toContain("missing nativeArgs")
		expect(results(cline)[0].is_error).toBe(true)
		expect(cline.mistakeTracker.count).toBe(1)
		expect(cline.tokenUsageTracker.recordToolError).toHaveBeenCalled()
		expect(cline.stream.didAlreadyUseTool).toBe(false)
		expect(handle).not.toHaveBeenCalled()
	})

	it("nativeArgs 欠落時に recordToolError が投げても握りつぶす", async () => {
		const { cline } = makeHost()
		cline.tokenUsageTracker.recordToolError = vi.fn(() => {
			throw new Error("boom")
		})

		await presentToolUse(cline as never, makeBlock({ nativeArgs: undefined }))

		expect(String(results(cline)[0].content)).toContain("missing nativeArgs")
	})

	it("未知ツールなら nativeArgs 欠落チェックはスキップする（partial 扱い）", async () => {
		// isKnownTool=false のとき missing-nativeArgs 分岐に入らないことの確認
		const { cline } = makeHost()
		mocks.isValidToolName.mockReturnValue(false)

		await presentToolUse(cline as never, makeBlock({ name: "read_file", nativeArgs: undefined }))

		// missing nativeArgs ではなく未知ツールの error になる
		expect(results(cline).some((r) => String(r.content).includes("missing nativeArgs"))).toBe(false)
	})
})

// --- 4. 承認ゲート（askApproval クロージャ） --------------------------------

describe("presentToolUse - 承認ゲート", () => {
	it("拒否（コメント無し）→ toolDenied を返し、以降を拒否済みにする", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({ response: "noButtonClicked" } as never)

		const ok = await askApproval("tool", "msg")

		expect(ok).toBe(false)
		expect(cline.stream.didRejectTool).toBe(true)
		expect(String(results(cline)[0].content)).toContain("The user denied this operation")
	})

	it("理由付き拒否 → user_feedback を say し、その文言を結果に載せる", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({
			response: "messageResponse",
			text: "やめて",
			images: ["data:image/png;base64,x"],
		} as never)

		const ok = await askApproval("tool", "msg")

		expect(ok).toBe(false)
		expect(cline.say).toHaveBeenCalledWith("user_feedback", "やめて", ["data:image/png;base64,x"])
		expect(String(results(cline)[0].content)).toContain("やめて")
	})

	it("承認（コメント無し）→ true を返し、say もしない", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({ response: "yesButtonClicked" } as never)

		const ok = await askApproval("tool", "msg")

		expect(ok).toBe(true)
		expect(cline.stream.didRejectTool).toBe(false)
		expect(cline.say).not.toHaveBeenCalled()
	})

	it("承認コメントは別 tool_result にせず、実際の結果へマージする", async () => {
		const { cline } = makeHost()
		const { askApproval, pushToolResult } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({
			response: "yesButtonClicked",
			text: "気をつけて",
			images: ["data:image/png;base64,y"],
		} as never)

		expect(await askApproval("tool", "msg")).toBe(true)
		pushToolResult("本体の結果")

		expect(results(cline)).toHaveLength(1)
		const content = String(results(cline)[0].content)
		expect(content).toContain("気をつけて")
		expect(content).toContain("本体の結果")
		// フィードバック画像は結果の userMessageContent 側へ積まれる
		expect(cline.stream.userMessageContent.length).toBeGreaterThan(0)
	})

	it("isProtected を渡した承認要求はそのまま ask に流す", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())

		await askApproval("tool", "msg", { icon: "check" }, true)

		expect(cline.ask).toHaveBeenLastCalledWith("tool", "msg", false, { icon: "check" }, true)
	})

	it("isProtected 未指定なら false に正規化して ask に渡す", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())

		await askApproval("tool", "msg")

		expect(cline.ask).toHaveBeenLastCalledWith("tool", "msg", false, undefined, false)
	})

	it("finishTask 承認は tool ask に finishTask を投げる", async () => {
		const { cline } = makeHost()
		const { askFinishSubTaskApproval } = await captureCallbacks(cline, makeBlock(), {
			extraCallbacks: ({ askFinishSubTaskApproval, toolDescription }: any) => ({
				askFinishSubTaskApproval,
				toolDescription,
			}),
		})

		await askFinishSubTaskApproval!()

		expect(cline.ask).toHaveBeenLastCalledWith(
			"tool",
			JSON.stringify({ tool: "finishTask" }),
			false,
			undefined,
			false,
		)
	})
})

// --- 5. pushToolResult は 1 件だけ / 整形 ------------------------------------

describe("presentToolUse - tool_result の整形と重複防止", () => {
	it("2 度目の pushToolResult は捨てて警告する", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult("first")
		pushToolResult("second")

		expect(results(cline)).toHaveLength(1)
		expect(results(cline)[0].content).toBe("first")
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping duplicate tool_result"))
		warn.mockRestore()
	})

	it("空文字の結果は「何も返さなかった」に置き換える", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult("")

		expect(results(cline)[0].content).toBe("(tool did not return anything)")
	})

	it("ブロック配列はテキストだけ連結し、画像は userMessageContent へ積む", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult([
			{ type: "text", text: "line1" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
			{ type: "text", text: "line2" },
		])

		expect(results(cline)[0].content).toBe("line1\nline2")
		expect(cline.stream.userMessageContent).toHaveLength(1)
		expect((cline.stream.userMessageContent[0] as { type: string }).type).toBe("image")
	})

	it("テキストが 1 つも無い配列も「何も返さなかった」にする", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult([{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }])

		expect(results(cline)[0].content).toBe("(tool did not return anything)")
	})
})

// --- 6. handleError クロージャ ----------------------------------------------

describe("presentToolUse - handleError", () => {
	it("AskIgnoredError は握りつぶし、エラーも結果も出さない", async () => {
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		await handleError("executing tool", new AskIgnoredError("superseded"))

		expect(cline.say).not.toHaveBeenCalled()
		expect(results(cline)).toEqual([])
	})

	it("通常のエラーは say して tool_result にも載せる", async () => {
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		await handleError("executing tool", new Error("boom"))

		expect(cline.say).toHaveBeenCalledWith("error", expect.stringContaining("boom"))
		expect(String(results(cline)[0].content)).toContain("Error executing tool")
	})

	it("message を持たない例外でもシリアライズして say する", async () => {
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		// message が無いので `error.message ?? JSON.stringify(serializeError(error))` の右辺を通る
		await handleError("executing tool", { name: "Weird", code: 7 } as unknown as Error)

		const said = cline.say.mock.calls[0] as unknown as [string, string]
		expect(said[0]).toBe("error")
		expect(said[1]).toContain("Error executing tool:")
		expect(said[1]).toContain("Weird")
	})
})

// --- 7. 検証失敗 -------------------------------------------------------------

describe("presentToolUse - 検証失敗", () => {
	it("validateToolUse が投げたら実行せず error 結果を返す", async () => {
		const { cline } = makeHost()
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }
		mocks.validateToolUse.mockImplementation(() => {
			throw new Error("Tool not allowed in this mode")
		})

		await presentToolUse(cline as never, makeBlock())

		expect(handle).not.toHaveBeenCalled()
		expect(cline.mistakeTracker.count).toBe(1)
		expect(results(cline)[0].is_error).toBe(true)
		expect(String(results(cline)[0].content)).toContain("not allowed")
		expect(cline.stream.didAlreadyUseTool).toBe(false)
	})

	it("provider（state）が無くても既定モードで検証を通す", async () => {
		const { cline } = makeHost({ noProvider: true })
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle, savesCheckpoint: false }

		await presentToolUse(cline as never, makeBlock())

		// state 未取得でも throw せず dispatch まで到達する
		expect(handle).toHaveBeenCalledTimes(1)
	})

	it("disabledTools と includedTools を検証へ渡す経路も通る", async () => {
		const { cline } = makeHost({
			state: { mode: "code", customModes: [], disabledTools: ["write_file"] },
			modelInfo: { includedTools: ["edit_file"] },
		})
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock())

		expect(mocks.validateToolUse).toHaveBeenCalledTimes(1)
		expect(handle).toHaveBeenCalledTimes(1)
	})
})

// --- 8. 繰り返し検出 ---------------------------------------------------------

describe("presentToolUse - 繰り返し検出", () => {
	it("繰り返し上限に達し、コメント返信付きなら feedback を反映して実行しない", async () => {
		const { cline } = makeHost({
			repetition: {
				allowExecution: false,
				askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated {toolName}" },
			},
			askResponse: { response: "messageResponse", text: "別の手で", images: ["data:image/png;base64,z"] },
		})
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.ask).toHaveBeenCalledWith("mistake_limit_reached", "repeated read_file")
		expect(
			cline.stream.userMessageContent.some((b) =>
				String((b as { text?: string }).text ?? "").includes("別の手で"),
			),
		).toBe(true)
		expect(cline.say).toHaveBeenCalledWith("user_feedback", "別の手で", ["data:image/png;base64,z"])
		expect(String(results(cline)[0].content)).toContain("repetition limit reached")
		expect(handle).not.toHaveBeenCalled()
	})

	it("繰り返し上限だがコメント無し（messageResponse 以外）でも結果は 1 件返す", async () => {
		const { cline } = makeHost({
			repetition: {
				allowExecution: false,
				askUser: { messageKey: "mistake_limit_reached", messageDetail: "repeated {toolName}" },
			},
			askResponse: { response: "yesButtonClicked" },
		})
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		expect(String(results(cline)[0].content)).toContain("repetition limit reached")
		expect(handle).not.toHaveBeenCalled()
	})

	it("allowExecution=false でも askUser が無ければ通常どおり dispatch する", async () => {
		const { cline } = makeHost({ repetition: { allowExecution: false } })
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock())

		expect(handle).toHaveBeenCalledTimes(1)
	})
})

// --- 9. dispatch と checkpoint ----------------------------------------------

describe("presentToolUse - dispatch と checkpoint", () => {
	it("承認された tool は解決済みのコールバックと共にちょうど 1 度 dispatch される", async () => {
		const { cline } = makeHost()
		const block = makeBlock()
		const handle = vi.fn(async (..._a: unknown[]) => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, block)

		expect(handle).toHaveBeenCalledTimes(1)
		const [task, passedBlock, callbacks] = handle.mock.calls[0]
		expect(task).toBe(cline)
		expect(passedBlock).toBe(block)
		expect(callbacks).toHaveProperty("askApproval")
		expect(callbacks).toHaveProperty("pushToolResult")
		expect(callbacks).toHaveProperty("handleError")
		expect(cline.tokenUsageTracker.recordToolUsage).toHaveBeenCalledWith("read_file")
	})

	it("ファイルを書き換える tool の前に checkpoint を取る", async () => {
		const { cline } = makeHost()
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle, savesCheckpoint: true }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.checkpointSave).toHaveBeenCalledWith(true)
		expect(cline.stream.currentStreamingDidCheckpoint).toBe(true)
		expect(handle).toHaveBeenCalledTimes(1)
	})

	it("既に checkpoint 済みなら二重には取らない", async () => {
		const { cline } = makeHost({ didCheckpoint: true })
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle, savesCheckpoint: true }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.checkpointSave).not.toHaveBeenCalled()
		expect(handle).toHaveBeenCalledTimes(1)
	})

	it("checkpoint 保存が失敗しても落ちず、フラグも立てないまま dispatch する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { cline } = makeHost({
			checkpointSave: async () => {
				throw new Error("disk full")
			},
		})
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle, savesCheckpoint: true }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.stream.currentStreamingDidCheckpoint).toBe(false)
		expect(handle).toHaveBeenCalledTimes(1)
		expect(errSpy).toHaveBeenCalled()
		errSpy.mockRestore()
	})

	it("checkpoint 不要な tool では checkpointSave を呼ばない", async () => {
		const { cline } = makeHost()
		const handle = vi.fn(async () => undefined)
		mocks.toolDispatch.read_file = { handle }

		await presentToolUse(cline as never, makeBlock())

		expect(cline.checkpointSave).not.toHaveBeenCalled()
	})
})

// --- 10. 未知ツールへのフォールスルー ----------------------------------------

describe("presentToolUse - 未知ツール", () => {
	it("dispatch エントリが無い確定ブロックは error 結果を返す", async () => {
		const { cline } = makeHost()
		// toolDispatch に read_file を登録しない → フォールスルー

		await presentToolUse(cline as never, makeBlock())

		expect(cline.mistakeTracker.count).toBe(1)
		expect(cline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("Unknown tool"),
		)
		expect(cline.say).toHaveBeenCalledWith("error", expect.stringContaining("unknownToolError"))
		expect(results(cline)[0].is_error).toBe(true)
	})

	it("dispatch エントリが無い partial ブロックは何もしない（結果を積まない）", async () => {
		const { cline } = makeHost()

		await presentToolUse(cline as never, makeBlock({ partial: true }))

		expect(results(cline)).toEqual([])
		expect(cline.say).not.toHaveBeenCalled()
	})
})
