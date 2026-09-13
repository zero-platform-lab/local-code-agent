// npx vitest run services/pii/__tests__/rates.spec.ts
//
// すり抜け率と誤検出率を測り、上限を固定する。
//
// **この数字は品質の証明ではない。** 文例は私たちが書いたもので、検出の作りに寄っている。
// 測っているのは「前より悪くなっていないか」であって、「何 % 安全か」ではない。
// 絶対の値が要るなら、別に用意した正解つきの文例が要る。
//
// **それでも置く理由。** 直すたびに別の場所が壊れることが実際に何度も起きた。1 件ずつの
// 試験は「その 1 件」しか見ないが、ここは全体をまとめて見る。誤検出が 1 件でも出たら、
// どこかの規則が広がりすぎている。
//
// 第 2 層はモデルが要るので、ここでは第 1 層だけを測る。第 2 層を含めた値は
// `docs/features/pii-proper-nouns.md` の「確かめ方」に手順がある。

import { CORPUS } from "./fixtures/corpus"
import { maskText } from "../maskText"

/**
 * 誤検出の上限。
 *
 * **0 より大きくしない。** 誤って伏せるとモデルが読む内容が変わり、取りこぼしと違って
 * あとから補えない。この一線は第 1 層でも第 2 層でも同じである。
 */
const MAX_FALSE_POSITIVE = 0

/**
 * すり抜けの上限。
 *
 * 第 1 層だけで測るので、第 2 層が要る文例は数えない。ここに挙げた形は第 1 層で全部
 * 取れるはずのものである。取れなくなったら、規則がどこかで狭まっている。
 */
const MAX_MISS = 0

describe("すり抜け率と誤検出率", () => {
	const layerOne = CORPUS.filter((one) => !one.needsLayerTwo)

	const measure = () => {
		const missed: string[] = []
		const wrong: string[] = []
		let pii = 0
		let clean = 0

		for (const one of layerOne) {
			const masked = maskText(one.text, {}).text
			for (const value of one.pii) {
				pii++
				if (masked.includes(value)) missed.push(`${value}｜${one.text}`)
			}
			for (const value of one.clean ?? []) {
				clean++
				if (!masked.includes(value)) wrong.push(`${value}｜${masked}`)
			}
		}

		return { missed, wrong, pii, clean }
	}

	it(`誤って伏せる割合が ${MAX_FALSE_POSITIVE}% 以下である`, () => {
		const { wrong, clean } = measure()

		expect(wrong, `誤検出: ${wrong.join(" / ")}`).toHaveLength(0)
		expect((wrong.length / clean) * 100).toBeLessThanOrEqual(MAX_FALSE_POSITIVE)
	})

	it(`すり抜ける割合が ${MAX_MISS}% 以下である`, () => {
		const { missed, pii } = measure()

		expect(missed, `すり抜け: ${missed.join(" / ")}`).toHaveLength(0)
		expect((missed.length / pii) * 100).toBeLessThanOrEqual(MAX_MISS)
	})

	it("文例が痩せていない", () => {
		// 通すために文例を削る、という直し方を塞ぐ。足すのはよい。
		expect(layerOne.length).toBeGreaterThanOrEqual(28)
		expect(layerOne.flatMap((one) => one.pii).length).toBeGreaterThanOrEqual(10)
		expect(layerOne.flatMap((one) => one.clean ?? []).length).toBeGreaterThanOrEqual(20)
	})
})
