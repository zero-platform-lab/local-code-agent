// npx vitest run core/assistant-message/__tests__/presentMcpToolUse.spec.ts
//
// presentMcpToolUse は `mcp_tool_use` ブロックを use_mcp_tool と同じ実行経路へ合流させる
// アダプタ。C0 4.7% / 関数 0%（123 行が未実行）で、承認・拒否・重複結果といった
// 「事故が起きる側」の経路が丸ごと未検証だった。
//
// ここで固定するのは次の 5 点:
//   1. **利用者が拒否したら MCP ツールは 1 度も呼ばれない**（ExecuteCommandTool.invariants.spec の
//      「拒否したらコマンドが 1 度も起動されない」と同じ形の不変条件）。
//      直前のツールが拒否済みのときも同様に、承認を求めずに実行へ進まない
//   2. native プロトコルの約束：tool_use には必ず tool_result を 1 つだけ返す
//      （拒否・中断・エラーでも欠けない／重複しない）
//   3. 承認時のフィードバックは別の tool_result にせず、実際の結果へマージされる
//   4. サニタイズ済みサーバ名を元の名前へ復元してから実行する
//   5. AskIgnoredError は「エラー」として扱わない（内部の制御シグナル）
//
// MCP クライアントは実体を一切起動しない。McpHub は callTool を含めて丸ごと贋物にし、
// 「callTool が呼ばれていないこと」をアサートできるようにしている。

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { McpToolUse } from "../../../shared/tools"

import { AskIgnoredError } from "../../task/AskIgnoredError"

// --- モック定義 -------------------------------------------------------------

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => (args ? `${key}(${JSON.stringify(args)})` : key),
}))

import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { presentMcpToolUse } from "../presentMcpToolUse"

// --- テスト用ヘルパ ---------------------------------------------------------

interface HostOptions {
	/** 直前のツールが拒否済み。 */
	didRejectTool?: boolean
	/** ask の応答。既定は承認。 */
	askResponse?: { response: string; text?: string; images?: string[] }
	/** providerRef.deref() を undefined にする。 */
	noProvider?: boolean
	/** getMcpHub() を undefined にする。 */
	noMcpHub?: boolean
	/** findServerNameBySanitizedName の戻り値。 */
	originalServerName?: string | null
	/** MCP サーバ一覧。 */
	servers?: Array<{ name: string; tools?: Array<{ name: string; enabledForPrompt?: boolean }> }>
	/** callTool の戻り値。 */
	toolResult?: unknown
}

function makeHost(options: HostOptions = {}) {
	const callTool = vi.fn(
		async (..._args: unknown[]) => options.toolResult ?? { content: [{ type: "text", text: "ok" }] },
	)

	const mcpHub = {
		getAllServers: vi.fn(() => options.servers ?? [{ name: "my server", tools: [{ name: "do-thing" }] }]),
		callTool,
		findServerNameBySanitizedName: vi.fn((_sanitized: string) =>
			options.originalServerName === undefined ? "my server" : options.originalServerName,
		),
	}

	const provider = {
		getMcpHub: vi.fn(() => (options.noMcpHub ? undefined : mcpHub)),
		postMessageToWebview: vi.fn(async (..._args: unknown[]) => undefined),
	}

	const cline = {
		taskId: "task-1",
		instanceId: "inst-1",
		stream: {
			didRejectTool: options.didRejectTool ?? false,
			didToolFailInCurrentTurn: false,
			userMessageContent: [] as unknown[],
		},
		askState: { lastMessageTs: 1_700_000_000_000 },
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolUsage: vi.fn(), recordToolError: vi.fn() },
		pushToolResultToUserContent: vi.fn((..._args: unknown[]) => true),
		providerRef: { deref: vi.fn(() => (options.noProvider ? undefined : provider)) },
		ask: vi.fn(async (..._args: unknown[]) => options.askResponse ?? { response: "yesButtonClicked" }),
		say: vi.fn(async (..._args: unknown[]) => undefined),
		sayAndCreateMissingParamError: vi.fn(async (_tool: string, param: string) => `missing:${param}`),
	}

	return { cline, provider, mcpHub, callTool }
}

function makeBlock(overrides: Partial<McpToolUse> = {}): McpToolUse {
	return {
		type: "mcp_tool_use",
		id: "call_1",
		name: "mcp_my_server_do_thing",
		serverName: "my_server",
		toolName: "do-thing",
		arguments: { a: 1 },
		partial: false,
		...overrides,
	}
}

/**
 * **MCP ツールが 1 度も呼ばれていないこと。** ExecuteCommandTool.invariants.spec の
 * `expectNoCommandRan` と同じ役割で、MCP 側の「取り返しがつかない副作用」に相当する。
 */
function expectMcpToolNeverCalled(callTool: ReturnType<typeof vi.fn>, label: string) {
	expect(callTool, `${label}: mcpHub.callTool`).not.toHaveBeenCalled()
}

/** pushToolResultToUserContent に渡った tool_result の全件。 */
function results(cline: ReturnType<typeof makeHost>["cline"]) {
	return cline.pushToolResultToUserContent.mock.calls.map(([r]) => r as Record<string, unknown>)
}

/**
 * useMcpToolTool.handle を差し替えて、presentMcpToolUse が組み立てたコールバックを
 * そのまま取り出す。クロージャ（pushToolResult / askApproval / handleError）の
 * 分岐をツール実装に依存せず直接動かすためのフック。
 */
async function captureCallbacks(cline: unknown, block: McpToolUse) {
	let captured: {
		askApproval: (...args: any[]) => Promise<boolean>
		handleError: (action: string, error: Error) => Promise<void>
		pushToolResult: (content: any, images?: string[]) => void
	}
	let handledBlock: unknown
	const spy = vi.spyOn(useMcpToolTool, "handle").mockImplementation(async (_task, b, callbacks) => {
		handledBlock = b
		captured = callbacks as never
	})

	await presentMcpToolUse(cline as never, block)
	spy.mockRestore()

	return { ...captured!, handledBlock: handledBlock as any }
}

beforeEach(() => {
	vi.clearAllMocks()
})

// --- 1. 拒否済みのときは実行しない -------------------------------------------

describe("presentMcpToolUse - 直前のツールが拒否済み", () => {
	it("**MCP ツールを 1 度も呼ばず、承認も求めない**", async () => {
		const { cline, callTool } = makeHost({ didRejectTool: true })

		await presentMcpToolUse(cline as never, makeBlock())

		expectMcpToolNeverCalled(callTool, "直前のツールが拒否済み")
		expect(cline.ask).not.toHaveBeenCalled()
		expect(cline.tokenUsageTracker.recordToolUsage).not.toHaveBeenCalled()
	})

	it("スキップした事実を is_error 付きの tool_result で必ず返す", async () => {
		// native プロトコルでは tool_use に対して tool_result が無いと API エラーになる。
		const { cline } = makeHost({ didRejectTool: true })

		await presentMcpToolUse(cline as never, makeBlock({ id: "call:x/y" }))

		expect(results(cline)).toEqual([
			{
				type: "tool_result",
				// ID は API の検証パターンに合わせてサニタイズされる
				tool_use_id: "call_x_y",
				content: "Skipping MCP tool mcp_my_server_do_thing due to user rejecting a previous tool.",
				is_error: true,
			},
		])
	})

	it("ストリーミング途中なら「中断された」旨のメッセージにする", async () => {
		const { cline } = makeHost({ didRejectTool: true })

		await presentMcpToolUse(cline as never, makeBlock({ partial: true }))

		expect(results(cline)[0].content).toBe(
			"MCP tool mcp_my_server_do_thing was interrupted and not executed due to user rejecting a previous tool.",
		)
	})

	it("tool_use_id が無いブロックでは結果を積まない", async () => {
		const { cline, callTool } = makeHost({ didRejectTool: true })

		await presentMcpToolUse(cline as never, makeBlock({ id: undefined }))

		expect(results(cline)).toEqual([])
		expectMcpToolNeverCalled(callTool, "id 無し・拒否済み")
	})
})

// --- 2. 承認ゲート -----------------------------------------------------------

describe("presentMcpToolUse - 承認ゲート", () => {
	it("**利用者が拒否したら MCP ツールは 1 度も呼ばれない**", async () => {
		// 承認チェックが抜けると、モデルの指示だけで外部 MCP サーバの副作用が走る。
		// ここが本経路最大の不変条件。
		const { cline, callTool } = makeHost({ askResponse: { response: "noButtonClicked" } })

		await presentMcpToolUse(cline as never, makeBlock())

		expectMcpToolNeverCalled(callTool, "利用者が拒否")
		expect(cline.ask).toHaveBeenCalledTimes(1)
		expect(cline.ask.mock.calls[0][0]).toBe("use_mcp_server")
		// 以降のツールもスキップさせる
		expect(cline.stream.didRejectTool).toBe(true)
	})

	it("拒否時は拒否した旨の tool_result をちょうど 1 件返す", async () => {
		const { cline } = makeHost({ askResponse: { response: "noButtonClicked" } })

		await presentMcpToolUse(cline as never, makeBlock())

		expect(results(cline)).toHaveLength(1)
		expect(String(results(cline)[0].content)).toContain("The user denied this operation")
	})

	it("拒否理由を書いて断ったら、その文言も結果に載る", async () => {
		const { cline, callTool } = makeHost({
			askResponse: {
				response: "messageResponse",
				text: "そのサーバは使わないで",
				images: ["data:image/png;base64,x"],
			},
		})

		await presentMcpToolUse(cline as never, makeBlock())

		expectMcpToolNeverCalled(callTool, "理由付き拒否")
		expect(cline.say).toHaveBeenCalledWith("user_feedback", "そのサーバは使わないで", ["data:image/png;base64,x"])
		expect(String(results(cline)[0].content)).toContain("そのサーバは使わないで")
	})

	it("承認したら MCP ツールが解決済みの名前で 1 度だけ呼ばれる", async () => {
		const { cline, callTool } = makeHost()

		await presentMcpToolUse(cline as never, makeBlock())

		expect(callTool).toHaveBeenCalledTimes(1)
		expect(callTool).toHaveBeenCalledWith("my server", "do-thing", { a: 1 })
		expect(cline.stream.didRejectTool).toBe(false)
	})

	it("承認コメントは別の tool_result にせず、実際の結果へマージする", async () => {
		// GitHub #10465: ここで別途 push すると tool_result が 2 件になり API エラーになる。
		const { cline } = makeHost({
			askResponse: { response: "yesButtonClicked", text: "気をつけて", images: ["data:image/png;base64,y"] },
			toolResult: { content: [{ type: "text", text: "server said hi" }] },
		})

		await presentMcpToolUse(cline as never, makeBlock())

		expect(results(cline)).toHaveLength(1)
		const content = String(results(cline)[0].content)
		expect(content).toContain("気をつけて")
		expect(content).toContain("server said hi")
		expect(cline.say).toHaveBeenCalledWith("user_feedback", "気をつけて", ["data:image/png;base64,y"])
		// フィードバック画像は画像ブロックとして先頭に積まれる
		expect(cline.stream.userMessageContent.length).toBeGreaterThan(0)
	})

	it("保護対象フラグを渡した承認要求もそのまま ask に流す", async () => {
		// useMcpToolTool は isProtected を渡さないが、コールバック自身は受け取れる。
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())

		await askApproval("use_mcp_server", "msg", { icon: "check" }, true)

		expect(cline.ask).toHaveBeenCalledWith("use_mcp_server", "msg", false, { icon: "check" }, true)
	})

	it("isProtected 未指定なら false に正規化して ask に渡す", async () => {
		const { cline } = makeHost()
		const { askApproval } = await captureCallbacks(cline, makeBlock())

		await askApproval("use_mcp_server", "msg")

		expect(cline.ask).toHaveBeenCalledWith("use_mcp_server", "msg", false, undefined, false)
	})
})

// --- 3. tool_result は 1 件だけ ----------------------------------------------

describe("presentMcpToolUse - tool_result の重複防止", () => {
	it("2 度目の pushToolResult は捨てて警告する", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult("first")
		pushToolResult("second")

		expect(results(cline)).toHaveLength(1)
		expect(results(cline)[0].content).toBe("first")
		expect(warn).toHaveBeenCalledWith(
			"[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: call_1",
		)
		warn.mockRestore()
	})

	it("空文字の結果は「何も返さなかった」に置き換える", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult("")

		expect(results(cline)[0].content).toBe("(tool did not return anything)")
	})

	it("ブロック配列はテキストだけを連結して返す", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult([
			{ type: "text", text: "line1" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
			{ type: "text", text: "line2" },
		])

		expect(results(cline)[0].content).toBe("line1\nline2")
		// 画像はテキストではなく userMessageContent 側へ積まれる
		expect(cline.stream.userMessageContent).toHaveLength(1)
		expect((cline.stream.userMessageContent[0] as { type: string }).type).toBe("image")
	})

	it("テキストが 1 つも無い配列も「何も返さなかった」にする", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult([{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }])

		expect(results(cline)[0].content).toBe("(tool did not return anything)")
		expect(cline.stream.userMessageContent).toHaveLength(1)
	})

	it("画像が無ければ userMessageContent には触らない", async () => {
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock())

		pushToolResult([{ type: "text", text: "only text" }])

		expect(cline.stream.userMessageContent).toEqual([])
	})

	it("tool_use_id が無ければ結果を積まないが、二重呼び出しは防いだままにする", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { cline } = makeHost()
		const { pushToolResult } = await captureCallbacks(cline, makeBlock({ id: undefined }))

		pushToolResult("first")
		pushToolResult("second")

		expect(results(cline)).toEqual([])
		expect(cline.stream.userMessageContent).toEqual([])
		expect(warn).toHaveBeenCalledWith(
			"[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: undefined",
		)
		warn.mockRestore()
	})

	it("承認コメントに画像が無い場合はテキストだけをマージする", async () => {
		const { cline } = makeHost()
		const { askApproval, pushToolResult } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({ response: "yesButtonClicked", text: "了解", images: undefined } as never)

		await askApproval("use_mcp_server", "msg")
		pushToolResult("result body")

		const content = String(results(cline)[0].content)
		expect(content).toContain("了解")
		expect(content).toContain("result body")
		expect(cline.stream.userMessageContent).toEqual([])
	})

	it("承認コメントの画像は結果画像より前に積む", async () => {
		const { cline } = makeHost()
		const { askApproval, pushToolResult } = await captureCallbacks(cline, makeBlock())
		cline.ask.mockResolvedValue({
			response: "yesButtonClicked",
			text: "了解",
			images: ["data:image/png;base64,feedback"],
		} as never)

		await askApproval("use_mcp_server", "msg")
		pushToolResult([
			{ type: "text", text: "body" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "result" } },
		])

		const images = cline.stream.userMessageContent as Array<{ source: { data: string } }>
		expect(images).toHaveLength(2)
		expect(images[0].source.data).toBe("feedback")
		expect(images[1].source.data).toBe("result")
	})
})

// --- 4. エラー処理 -----------------------------------------------------------

describe("presentMcpToolUse - エラー処理", () => {
	it("AskIgnoredError は握りつぶし、エラーも結果も出さない", async () => {
		// 新しい ask が古い ask を追い越しただけの内部シグナル。
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		await handleError("executing MCP tool", new AskIgnoredError("superseded"))

		expect(cline.say).not.toHaveBeenCalled()
		expect(results(cline)).toEqual([])
	})

	it("通常のエラーは say して tool_result にも載せる", async () => {
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		await handleError("executing MCP tool", new Error("boom"))

		expect(cline.say).toHaveBeenCalledWith("error", "Error executing MCP tool:\nboom")
		expect(String(results(cline)[0].content)).toContain("Error executing MCP tool")
		expect(String(results(cline)[0].content)).toContain("boom")
	})

	it("message を持たない例外でもシリアライズして伝える", async () => {
		const { cline } = makeHost()
		const { handleError } = await captureCallbacks(cline, makeBlock())

		await handleError("executing MCP tool", { name: "Weird", code: 7 } as unknown as Error)

		const said = cline.say.mock.calls[0] as unknown as [string, string]
		expect(said[0]).toBe("error")
		expect(said[1]).toContain("Error executing MCP tool:")
		expect(said[1]).toContain('"code": 7')
	})

	it("ツール実行中の例外は tool_result として返る（結果が欠けない）", async () => {
		const { cline, mcpHub } = makeHost()
		mcpHub.callTool.mockRejectedValue(new Error("mcp server down"))

		await presentMcpToolUse(cline as never, makeBlock())

		expect(results(cline)).toHaveLength(1)
		expect(String(results(cline)[0].content)).toContain("mcp server down")
	})
})

// --- 5. サーバ名の解決とツール使用量の記録 ------------------------------------

describe("presentMcpToolUse - サーバ名の解決", () => {
	it("サニタイズ済み名を元の名前へ復元してから実行する", async () => {
		const { cline, mcpHub, callTool } = makeHost({ originalServerName: "my server" })

		await presentMcpToolUse(cline as never, makeBlock({ serverName: "my_server" }))

		expect(mcpHub.findServerNameBySanitizedName).toHaveBeenCalledWith("my_server")
		expect(callTool).toHaveBeenCalledWith("my server", "do-thing", { a: 1 })
	})

	it("元の名前が見つからなければサニタイズ済み名のまま使う", async () => {
		const { cline, callTool } = makeHost({
			originalServerName: null,
			servers: [{ name: "my_server", tools: [{ name: "do-thing" }] }],
		})

		await presentMcpToolUse(cline as never, makeBlock({ serverName: "my_server" }))

		expect(callTool).toHaveBeenCalledWith("my_server", "do-thing", { a: 1 })
	})

	it("McpHub が無ければ名前解決を試みずそのまま渡す", async () => {
		const { cline } = makeHost({ noMcpHub: true })

		const { handledBlock } = await captureCallbacks(cline, makeBlock({ serverName: "my_server" }))

		expect(handledBlock.params.server_name).toBe("my_server")
		expect(handledBlock.nativeArgs.server_name).toBe("my_server")
	})

	it("provider が失われていても落ちない", async () => {
		const { cline } = makeHost({ noProvider: true })

		const { handledBlock } = await captureCallbacks(cline, makeBlock({ serverName: "my_server" }))

		expect(handledBlock.params.server_name).toBe("my_server")
	})

	it("use_mcp_tool 相当の合成ブロックへ引数をそのまま写す", async () => {
		const { cline } = makeHost()

		const { handledBlock } = await captureCallbacks(
			cline,
			makeBlock({ id: "call_9", toolName: "do-thing", arguments: { a: 1, b: [2] } }),
		)

		expect(handledBlock).toMatchObject({
			type: "tool_use",
			id: "call_9",
			name: "use_mcp_tool",
			partial: false,
			params: {
				server_name: "my server",
				tool_name: "do-thing",
				// params 側は文字列化された引数
				arguments: JSON.stringify({ a: 1, b: [2] }),
			},
			nativeArgs: {
				server_name: "my server",
				tool_name: "do-thing",
				// nativeArgs 側は構造化のまま
				arguments: { a: 1, b: [2] },
			},
		})
	})

	it("確定ブロックだけをツール使用量として記録する", async () => {
		const { cline } = makeHost()

		await presentMcpToolUse(cline as never, makeBlock())

		expect(cline.tokenUsageTracker.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
	})

	it("ストリーミング途中は使用量を記録せず、進行表示だけを出す", async () => {
		const { cline, callTool } = makeHost()

		await presentMcpToolUse(cline as never, makeBlock({ partial: true }))

		expect(cline.tokenUsageTracker.recordToolUsage).not.toHaveBeenCalled()
		expectMcpToolNeverCalled(callTool, "ストリーミング途中")
		expect(cline.ask).toHaveBeenCalledWith("use_mcp_server", expect.any(String), true)
	})
})
