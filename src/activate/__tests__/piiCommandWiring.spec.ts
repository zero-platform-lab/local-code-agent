// npx vitest run activate/__tests__/piiCommandWiring.spec.ts
//
// 右クリックのファイルの置き換えに、第 2 層が渡っていることを固定する。
//
// **この試験を書いた理由。** `src/extension.ts` は第 2 層を「動いている会話」からだけ
// 借りていた。会話が無ければ `undefined` を渡すので、右クリックの置き換えは第 1 層だけで
// 実行される。第 1 層は敬称から人名を当てる規則を持たない（誤検出が多く、外した）ため、
// **辞書に書いた名前しか消えなかった。**
//
// 単体の試験では見つからない。`maskSecretsInActiveEditor` は渡されたものを使うだけで、
// 渡す側の `extension.ts` には試験が無い。**渡しているかどうかは、読んで数えるしかない。**

import * as path from "path"
import { promises as fs } from "fs"

const SRC = path.resolve(__dirname, "../..")

async function extensionSource(): Promise<string> {
	return fs.readFile(path.join(SRC, "extension.ts"), "utf8")
}

/** `registerPiiCommands(` から、対応する閉じ括弧までを取り出す。 */
function callBlock(source: string): string {
	const start = source.indexOf("registerPiiCommands(\n")
	if (start < 0) throw new Error("registerPiiCommands の呼び出しが読めない")

	let depth = 0
	for (let at = source.indexOf("(", start); at < source.length; at++) {
		if (source[at] === "(") depth++
		else if (source[at] === ")" && --depth === 0) return source.slice(start, at + 1)
	}
	throw new Error("閉じ括弧が見つからない")
}

describe("右クリックの置き換えに第 2 層を渡す（FR-PII-11e）", () => {
	it("会話が無くても使える伏せ字から借りている", async () => {
		const block = callBlock(await extensionSource())

		// 会話が無ければその場限りのものを返す。ここを `getCurrentTask()?.piiMasker` だけに
		// すると、会話を開いていないときに人名が残る。
		expect(block).toContain("piiMaskerFor(provider)")
	})

	it("第 2 層を渡さない道が残っていない", async () => {
		const block = callBlock(await extensionSource())

		// `undefined` を返す枝があれば、その枝を通ったときだけ人名が残る。画面には何も
		// 出ないので、気づく手がかりが 1 つも無い。
		expect(block).not.toMatch(/:\s*undefined\b/)
		expect(block).not.toMatch(/\?\s*\(texts\)/)
	})

	it("読み取り自体が空振りしていない", async () => {
		// 呼び出しの形が変わると、上の 2 つがいつでも通ってしまう。
		expect(callBlock(await extensionSource()).length).toBeGreaterThan(200)
	})
})
