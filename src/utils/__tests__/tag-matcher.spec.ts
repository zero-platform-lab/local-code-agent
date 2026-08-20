// npx vitest run utils/__tests__/tag-matcher.spec.ts
//
// TagMatcher は provider ストリームから `<think>...</think>` のような
// タグ区切り領域を「本文」と「タグ内」に分離する。ストリーム前提なので、
// 1) 途中でぶつ切りにされた入力でも落ちない
// 2) 開き / 閉じが壊れていても text として安全に流す
// を不変条件として固定する。

import { describe, it, expect } from "vitest"

import { TagMatcher, type TagMatcherResult } from "../tag-matcher"

/** 1 ショットで全チャンクを取り出す（final が collect+pop まで行う）。 */
function runOneShot(input: string, tag = "think", position = 0): TagMatcherResult[] {
	return new TagMatcher(tag, undefined, position).final(input) as TagMatcherResult[]
}

/** matched=true のデータだけを連結する。 */
function matchedText(chunks: TagMatcherResult[]): string {
	return chunks
		.filter((c) => c.matched)
		.map((c) => c.data)
		.join("")
}

/** matched=false のデータだけを連結する。 */
function unmatchedText(chunks: TagMatcherResult[]): string {
	return chunks
		.filter((c) => !c.matched)
		.map((c) => c.data)
		.join("")
}

describe("TagMatcher", () => {
	it("先頭のタグを認識し、中身だけを matched として返す", () => {
		const chunks = runOneShot("<think>hello</think>")
		expect(matchedText(chunks)).toBe("hello")
		// 開きタグ・閉じタグ自体は出力に残さない。
		expect(unmatchedText(chunks)).toBe("")
	})

	it("position で途中からのタグ開始を許可すると、前後の text と分離される", () => {
		// position=5 なら 6 文字目の '<' を開きタグとして認識する。
		const chunks = runOneShot("hello<think>x</think>", "think", 5)
		expect(unmatchedText(chunks)).toBe("hello")
		expect(matchedText(chunks)).toBe("x")
		// text → matched の境界で別チャンクに割れている。
		expect(chunks.length).toBe(2)
	})

	it("既定 position では途中の '<' は本文としてそのまま流す", () => {
		// 先頭以外の '<' はタグ開始と見なさない（matched でもないため）。
		const chunks = runOneShot("a<b")
		expect(matchedText(chunks)).toBe("")
		expect(unmatchedText(chunks)).toBe("a<b")
	})

	it("開きタグの綴りが違えば text に戻す", () => {
		const chunks = runOneShot("<xyz>data")
		expect(matchedText(chunks)).toBe("")
		expect(unmatchedText(chunks)).toBe("<xyz>data")
	})

	it("開きタグ内の空白を許容する（`<think >`）", () => {
		const chunks = runOneShot("<think >hi</think>")
		expect(matchedText(chunks)).toBe("hi")
	})

	it("閉じタグ内の空白を許容する（`</think >`）", () => {
		const chunks = runOneShot("<think>hi</think >")
		expect(matchedText(chunks)).toBe("hi")
	})

	it("閉じタグの綴りが違えば text に戻し、領域は閉じない", () => {
		// `</thonk>` は閉じタグとして成立しないので matched のまま本文へ落ちる。
		const chunks = runOneShot("<think>a</thonk>b")
		expect(matchedText(chunks)).toContain("a")
		// 綴り違いの閉じタグ片は本文（matched 領域）に取り込まれる。
		expect(matchedText(chunks)).toContain("thonk")
	})

	it("入れ子のタグでも落ちず、深さで開閉を管理する", () => {
		const chunks = runOneShot("<think>a<think>b</think>c</think>")
		// 一番外側が閉じるまで matched 領域が続く。
		const matched = matchedText(chunks)
		expect(matched).toContain("a")
		expect(matched).toContain("b")
		expect(matched).toContain("c")
		// 最終的にすべて閉じるので、末尾に matched が残らない（外側の閉じで cached はクリアされる）。
	})

	describe("壊れた / 境界入力でも落ちない", () => {
		it("閉じられないタグは中身を matched として吐き出す", () => {
			const chunks = runOneShot("<think>hello")
			expect(matchedText(chunks)).toBe("hello")
		})

		it("途中で切れた開きタグは text として flush する", () => {
			const chunks = runOneShot("<thin")
			expect(unmatchedText(chunks)).toBe("<thin")
		})

		it("開きの無い閉じタグだけでも例外を投げない", () => {
			expect(() => runOneShot("</think>plain")).not.toThrow()
		})

		it("空入力なら空配列を返す", () => {
			expect(runOneShot("")).toEqual([])
		})

		it("空文字 update でも落ちない", () => {
			const m = new TagMatcher("think")
			expect(m.update("")).toEqual([])
			expect(m.final()).toEqual([])
		})

		it("空タグ名（`<>`）でも例外を投げない", () => {
			expect(() => runOneShot("<>content", "")).not.toThrow()
		})
	})

	it("transform を渡すと各チャンクへ適用される", () => {
		const m = new TagMatcher<string>("think", (c) => `[${c.matched ? "R" : "T"}]${c.data}`, 5)
		const out = m.final("hi<think>yo</think>")
		expect(out).toEqual(["[T]hi", "[R]yo"])
	})

	it("1 文字ずつ流しても 1 ショットと同じ matched/text になる（ストリーム等価）", () => {
		const input = "pre<think>mid</think>post"
		const position = 3

		const oneShot = runOneShot(input, "think", position)

		const streaming = new TagMatcher("think", undefined, position)
		const collected: TagMatcherResult[] = []
		for (const ch of input) {
			collected.push(...(streaming.update(ch) as TagMatcherResult[]))
		}
		collected.push(...(streaming.final() as TagMatcherResult[]))

		expect(matchedText(collected)).toBe(matchedText(oneShot))
		expect(unmatchedText(collected)).toBe(unmatchedText(oneShot))
		expect(matchedText(oneShot)).toBe("mid")
		expect(unmatchedText(oneShot)).toBe("prepost")
	})
})
