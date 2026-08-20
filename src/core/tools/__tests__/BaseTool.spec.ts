// npx vitest run core/tools/__tests__/BaseTool.spec.ts
//
// BaseTool は全ツールの共通入口 `handle()` を持つ。ここが守るのは
//   - partial（ストリーミング）は handlePartial に流し、例外を握りつぶさず handleError へ回す
//   - 本実行では **nativeArgs が無ければ実行しない**（XML/引数欠落は明示エラーで拒否）
//   - パスの安定判定（hasPathStabilized）が「同じ値を 2 回見るまで確定しない」こと
// これらが崩れると、未確定の引数でツールが走る／失敗が黙って消える。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { BaseTool, type ToolCallbacks } from "../BaseTool"
import type { ToolUse } from "../../../shared/tools"

/**
 * handlePartial を上書きしない素のツール。
 * execute の呼び出しを記録し、protected メンバをテストへ露出する。
 */
class BareTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	executeCalls: Array<{ params: unknown; task: unknown }> = []

	async execute(params: unknown, task: unknown): Promise<void> {
		this.executeCalls.push({ params, task })
	}

	// protected を検証で叩けるように公開
	callHasPathStabilized(path: string | undefined): boolean {
		return this.hasPathStabilized(path)
	}
	peekLastSeen(): string | undefined {
		return this.lastSeenPartialPath
	}
}

/** handlePartial が Error を投げるツール。 */
class ThrowingErrorPartialTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	async execute(): Promise<void> {}
	override async handlePartial(): Promise<void> {
		throw new Error("partial-boom")
	}
}

/** handlePartial が Error 以外（文字列）を投げるツール。 */
class ThrowingStringPartialTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	async execute(): Promise<void> {}
	override async handlePartial(): Promise<void> {
		// 非 Error を throw して handleError 経路を試す（このリポの eslint 設定に
		// no-throw-literal は無いので disable コメントは不要）。
		throw "partial-string-boom"
	}
}

function makeCallbacks(): ToolCallbacks & {
	askApproval: ReturnType<typeof vi.fn>
	handleError: ReturnType<typeof vi.fn>
	pushToolResult: ReturnType<typeof vi.fn>
} {
	return {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(() => {}),
	} as never
}

/** ToolUse を最小構成で組む。 */
function block(overrides: Partial<ToolUse<"read_file">>): ToolUse<"read_file"> {
	return {
		type: "tool_use",
		name: "read_file",
		params: {},
		partial: false,
		...overrides,
	} as ToolUse<"read_file">
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	// handle() は失敗時に console.error でログするので、出力を抑えつつ呼び出しを観測する
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	errorSpy.mockRestore()
})

describe("BaseTool.handle - partial 経路", () => {
	it("partial では handlePartial に流し、execute は呼ばない（既定は no-op）", async () => {
		const tool = new BareTool()
		const cb = makeCallbacks()

		await tool.handle({} as never, block({ partial: true }), cb)

		expect(tool.executeCalls).toHaveLength(0)
		expect(cb.handleError).not.toHaveBeenCalled()
	})

	it("handlePartial が Error を投げたら握りつぶさず handleError に渡す", async () => {
		const tool = new ThrowingErrorPartialTool()
		const cb = makeCallbacks()

		await tool.handle({} as never, block({ partial: true }), cb)

		expect(cb.handleError).toHaveBeenCalledTimes(1)
		const [label, err] = cb.handleError.mock.calls[0]
		expect(label).toBe("handling partial read_file")
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toBe("partial-boom")
		expect(errorSpy).toHaveBeenCalled()
	})

	it("handlePartial が Error 以外を投げても Error に包んで handleError へ渡す", async () => {
		const tool = new ThrowingStringPartialTool()
		const cb = makeCallbacks()

		await tool.handle({} as never, block({ partial: true }), cb)

		const [, err] = cb.handleError.mock.calls[0]
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toBe("partial-string-boom")
	})
})

describe("BaseTool.handle - 本実行の引数取得", () => {
	it("nativeArgs があればそれを渡して execute する", async () => {
		const tool = new BareTool()
		const cb = makeCallbacks()
		const nativeArgs = { path: "a.ts" }
		const task = { id: "t" }

		await tool.handle(task as never, block({ nativeArgs: nativeArgs as never }), cb)

		expect(tool.executeCalls).toHaveLength(1)
		expect(tool.executeCalls[0].params).toBe(nativeArgs)
		expect(tool.executeCalls[0].task).toBe(task)
		expect(cb.handleError).not.toHaveBeenCalled()
	})

	it("nativeArgs が無く、params が XML 由来なら XML 非対応エラーで拒否する", async () => {
		const tool = new BareTool()
		const cb = makeCallbacks()

		await tool.handle(
			{} as never,
			block({ nativeArgs: undefined, params: { path: "<file>a.ts</file>" } as never }),
			cb,
		)

		// 実行しない
		expect(tool.executeCalls).toHaveLength(0)
		expect(cb.handleError).toHaveBeenCalledTimes(1)
		const [label, err] = cb.handleError.mock.calls[0]
		expect(label).toBe("parsing read_file args")
		expect((err as Error).message).toContain("XML tool calls are no longer supported")
	})

	it("'<' はあるが '>' が無い params は XML 判定せず、引数欠落エラーにする", async () => {
		// `includes("<") && includes(">")` の右辺短絡を固定する
		const tool = new BareTool()
		const cb = makeCallbacks()

		await tool.handle({} as never, block({ nativeArgs: undefined, params: { a: "<" } as never }), cb)

		expect(tool.executeCalls).toHaveLength(0)
		const [, err] = cb.handleError.mock.calls[0]
		expect((err as Error).message).toContain("missing native arguments")
	})

	it("nativeArgs が無く params も普通なら『引数欠落』エラーで拒否する", async () => {
		const tool = new BareTool()
		const cb = makeCallbacks()

		// params 未指定 → `block.params ?? {}` の右辺（{}）を通す
		await tool.handle({} as never, block({ nativeArgs: undefined, params: undefined as never }), cb)

		expect(tool.executeCalls).toHaveLength(0)
		const [, err] = cb.handleError.mock.calls[0]
		expect((err as Error).message).toContain("Tool call is missing native arguments")
	})

	it("params が JSON.stringify で落ちても（循環参照）落ちずに引数欠落として扱う", async () => {
		const tool = new BareTool()
		const cb = makeCallbacks()
		const circular: Record<string, unknown> = {}
		circular.self = circular

		await tool.handle({} as never, block({ nativeArgs: undefined, params: circular as never }), cb)

		// paramsText が "" に潰れ、XML 判定もされず引数欠落へ
		expect(tool.executeCalls).toHaveLength(0)
		const [, err] = cb.handleError.mock.calls[0]
		expect((err as Error).message).toContain("missing native arguments")
	})

	it("引数取得中に Error 以外が投げられても String 化して報告する", async () => {
		// nativeArgs へのアクセス自体が非 Error を投げる状況を作り、
		// `error instanceof Error ? error.message : String(error)` の else 側を通す
		const tool = new BareTool()
		const cb = makeCallbacks()
		const evil = block({})
		Object.defineProperty(evil, "nativeArgs", {
			get() {
				throw "raw-nonerror"
			},
		})

		await tool.handle({} as never, evil, cb)

		expect(tool.executeCalls).toHaveLength(0)
		const [, err] = cb.handleError.mock.calls[0]
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toContain("raw-nonerror")
	})
})

describe("BaseTool.hasPathStabilized / resetPartialState", () => {
	it("初回は未確定（false）で、値を記憶する", () => {
		const tool = new BareTool()
		expect(tool.callHasPathStabilized("a.ts")).toBe(false)
		expect(tool.peekLastSeen()).toBe("a.ts")
	})

	it("同じ非空パスを 2 回見たら確定（true）", () => {
		const tool = new BareTool()
		tool.callHasPathStabilized("a.ts")
		expect(tool.callHasPathStabilized("a.ts")).toBe(true)
	})

	it("値が変われば確定しない（false）", () => {
		const tool = new BareTool()
		tool.callHasPathStabilized("a.ts")
		expect(tool.callHasPathStabilized("b.ts")).toBe(false)
	})

	it("空文字は 2 回見ても確定しない（!!path の false 側）", () => {
		const tool = new BareTool()
		tool.callHasPathStabilized("")
		expect(tool.callHasPathStabilized("")).toBe(false)
	})

	it("resetPartialState 後は再び初回扱いに戻る", () => {
		const tool = new BareTool()
		tool.callHasPathStabilized("a.ts")
		tool.resetPartialState()
		expect(tool.peekLastSeen()).toBeUndefined()
		// リセット直後の同値はまた未確定から始まる
		expect(tool.callHasPathStabilized("a.ts")).toBe(false)
	})
})

describe("BaseTool.handlePartial - 既定実装", () => {
	it("既定の handlePartial は何もせず解決する", async () => {
		const tool = new BareTool()
		await expect(tool.handlePartial({} as never, block({ partial: true }))).resolves.toBeUndefined()
	})
})
