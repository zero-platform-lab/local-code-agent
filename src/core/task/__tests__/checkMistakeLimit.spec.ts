import { describe, it, expect, vi } from "vitest"

import { checkMistakeLimit } from "../checkMistakeLimit"

function makeDeps(
	opts: {
		count?: number
		limit?: number
		askResult?: { response: string; text?: string; images?: string[] }
	} = {},
) {
	const ask = vi.fn((..._a: unknown[]) => Promise.resolve(opts.askResult ?? { response: "yesButtonClicked" }))
	const say = vi.fn((..._a: unknown[]) => Promise.resolve())
	const deps = {
		host: { mistakeTracker: { count: opts.count ?? 0, limit: opts.limit ?? 3 } },
		ask,
		say,
	}
	return { deps, ask, say }
}

describe("checkMistakeLimit", () => {
	it("limit が 0（無効）なら count に関わらず発火しない", async () => {
		const { deps, ask, say } = makeDeps({ limit: 0, count: 99 })

		const result = await checkMistakeLimit(deps as never)

		expect(result).toEqual({ additionalContent: [], fired: false })
		expect(ask).not.toHaveBeenCalled()
		expect(say).not.toHaveBeenCalled()
	})

	it("count が limit 未満なら発火しない", async () => {
		const { deps, ask } = makeDeps({ limit: 3, count: 2 })

		const result = await checkMistakeLimit(deps as never)

		expect(result).toEqual({ additionalContent: [], fired: false })
		expect(ask).not.toHaveBeenCalled()
	})

	it("上限到達でダイアログを投げるが、ユーザーが応答しなければ fired=true・追加コンテンツ無し・say も呼ばない", async () => {
		const { deps, ask, say } = makeDeps({ limit: 3, count: 3, askResult: { response: "yesButtonClicked" } })

		const result = await checkMistakeLimit(deps as never)

		expect(ask).toHaveBeenCalledWith("mistake_limit_reached", expect.any(String))
		expect(result).toEqual({ additionalContent: [], fired: true })
		expect(say).not.toHaveBeenCalled()
	})

	it("ユーザーが追加指示を返したら user_feedback を say し、guidance テキスト+画像ブロックを追加する", async () => {
		const images = ["data:image/png;base64,abc123"]
		const { deps, ask, say } = makeDeps({
			limit: 3,
			count: 5,
			askResult: { response: "messageResponse", text: "do better", images },
		})

		const result = await checkMistakeLimit(deps as never)

		expect(ask).toHaveBeenCalledTimes(1)
		expect(say).toHaveBeenCalledWith("user_feedback", "do better", images)
		expect(result.fired).toBe(true)
		expect(result.additionalContent).toHaveLength(2)
		expect(result.additionalContent[0]).toMatchObject({ type: "text" })
		expect((result.additionalContent[0] as { text: string }).text).toContain("do better")
		expect((result.additionalContent[0] as { text: string }).text).toContain("guidance")
		expect(result.additionalContent[1]).toMatchObject({ type: "image" })
	})

	it("text/images が無い応答でも user_feedback には空文字を渡し、画像ブロックは付かない", async () => {
		const { deps, say } = makeDeps({
			limit: 3,
			count: 3,
			askResult: { response: "messageResponse" },
		})

		const result = await checkMistakeLimit(deps as never)

		expect(say).toHaveBeenCalledWith("user_feedback", "", undefined)
		expect(result.fired).toBe(true)
		expect(result.additionalContent).toHaveLength(1)
		expect(result.additionalContent[0]).toMatchObject({ type: "text" })
	})
})
