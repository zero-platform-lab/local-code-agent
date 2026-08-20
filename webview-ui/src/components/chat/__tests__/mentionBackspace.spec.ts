// npx vitest run src/components/chat/__tests__/mentionBackspace.spec.ts

import { resolveMentionBackspace } from "../mentionBackspace"

/** `@/src/a.ts` のようなメンション 1 個ぶん。 */
const MENTION = "@/src/a.ts"

const at = (inputValue: string, cursorPosition: number, justDeletedSpaceAfterMention = false) =>
	resolveMentionBackspace({ inputValue, cursorPosition, justDeletedSpaceAfterMention })

describe("resolveMentionBackspace — plain text", () => {
	it("just forgets state when the cursor is in ordinary text", () => {
		expect(at("hello world", 5)).toEqual({ kind: "forget" })
	})

	it("forgets state at the very start of the input", () => {
		expect(at("hello", 0)).toEqual({ kind: "forget" })
	})

	it("forgets state on an empty input", () => {
		expect(at("", 0)).toEqual({ kind: "forget" })
	})

	it("does not treat a space that follows ordinary text as a mention boundary", () => {
		expect(at("hello ", 6)).toEqual({ kind: "forget" })
	})
})

describe("resolveMentionBackspace — the space right after a mention", () => {
	it("collapses onto the end of the mention instead of deleting the space", () => {
		// "@/src/a.ts more" でカーソルが空白の直後。
		const input = `${MENTION} more`
		const action = at(input, MENTION.length + 1)

		expect(action).toEqual({
			kind: "collapse-space-after-mention",
			newCursorPosition: MENTION.length,
			moveCaret: true,
		})
	})

	it("lets the space be deleted normally when more whitespace follows", () => {
		// メンションの後ろが空白続きなら、寄せずに通常の削除に任せる。
		const input = `${MENTION}   `
		const action = at(input, MENTION.length + 1)

		expect(action).toMatchObject({ kind: "collapse-space-after-mention", moveCaret: false })
	})

	it("applies regardless of whether a previous collapse happened", () => {
		const input = `${MENTION} x`

		expect(at(input, MENTION.length + 1, true).kind).toBe("collapse-space-after-mention")
		expect(at(input, MENTION.length + 1, false).kind).toBe("collapse-space-after-mention")
	})

	it("treats a newline after the mention as the boundary too", () => {
		const input = `${MENTION}\nnext`

		expect(at(input, MENTION.length + 1).kind).toBe("collapse-space-after-mention")
	})

	it("does not trigger once a word separates the mention from the space", () => {
		// "@/src/a.ts x " の末尾。直前は空白だが、その手前はメンションではないので対象外。
		const input = `${MENTION} x `

		expect(at(input, input.length - 1)).toEqual({ kind: "forget" })
	})

	it("absorbs trailing path characters into the mention rather than ending it", () => {
		// "@/src/a.ts" + "x" は "@/src/a.tsx" という 1 つのメンションとして解釈される。
		// 区切りになるのは空白であってトークンの見た目ではない。
		const input = `${MENTION}x `

		expect(at(input, MENTION.length + 2).kind).toBe("collapse-space-after-mention")
	})

	it("does not trigger in the middle of a mention", () => {
		expect(at(`${MENTION} `, 4).kind).toBe("forget")
	})
})

describe("resolveMentionBackspace — deleting the mention itself", () => {
	it("removes the mention on the second backspace", () => {
		// 直前に空白を畳んでいるので、今度は本体を消す。
		const action = at(MENTION, MENTION.length, true)

		expect(action.kind).toBe("remove-mention")
		expect(action.kind === "remove-mention" && action.removed).not.toBeNull()
	})

	it("reports the resulting text and caret position", () => {
		const action = at(`${MENTION}`, MENTION.length, true)

		if (action.kind !== "remove-mention" || !action.removed) {
			throw new Error("expected a removal")
		}

		expect(action.removed.newText).not.toBe(MENTION)
		expect(typeof action.removed.newCursorPosition).toBe("number")
	})

	it("still collapses the flag when there was nothing to remove", () => {
		// 消せるメンションが無くても、フラグとメニューは畳む（removed が null）。
		const action = at("plain text", 5, true)

		expect(action).toEqual({ kind: "remove-mention", removed: null })
	})

	it("does not attempt removal when the flag is not set", () => {
		expect(at(MENTION, MENTION.length, false).kind).toBe("forget")
	})
})

describe("resolveMentionBackspace — preserved quirks", () => {
	it("looks one character too far ahead when deciding about following whitespace", () => {
		// 「カーソルの次の文字」は本来 [cursorPosition] のはずだが、分割前から
		// [cursorPosition + 1] を見ている。"@/src/a.ts  x" でキャレットが 1 つ目の空白の
		// 直後 (11) にあるとき、実際の次の文字は 2 つ目の空白 (index 11) なのに、
		// コードは index 12 の "x" を見る。その結果「後ろに語が続く」と誤判定し、
		// 空白を消さずキャレットを寄せる方を選ぶ。
		//
		// 直すとキャレット挙動が変わるため、意図的にこの値で固定している。
		const input = `${MENTION}  x`

		expect(input[MENTION.length + 1]).toBe(" ") // 本当の「次の文字」は空白
		expect(at(input, MENTION.length + 1)).toEqual({
			kind: "collapse-space-after-mention",
			newCursorPosition: MENTION.length,
			moveCaret: true, // 空白なのに true になるのが +1 のずれの影響
		})
	})

	it("never matches the two-character sequence \\r\\n by index lookup", () => {
		// 条件に "\\r\\n" が含まれるが、1 文字の添字アクセスでは決して一致しない。
		const input = `${MENTION}\r\nnext`
		const action = at(input, MENTION.length + 1)

		// "\\r" 単体は空白扱いされないので、メンション境界とは判定されない。
		expect(action.kind).toBe("forget")
	})
})
