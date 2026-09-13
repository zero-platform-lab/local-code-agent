// npx vitest run services/pii/__tests__/maskingSeams.invariants.spec.ts
//
// 伏せる処理と戻す処理を挟む、呼び出し箇所の数を固定する。
//
// **この試験を書いた理由。** 伏せ字の機能では、挟み忘れを 4 回のうち 3 回繰り返した。
// LLM へ送る呼び出しは 3 箇所、ツールの引数を解釈する呼び出しは 4 箇所あり、毎回 1 つずつ
// 残していた。
//
// 単体の試験では見つからない。直した箇所の試験は通り、残った箇所の試験も（伏せ字を
// 知らないので）通る。被覆率も 100% のままである。**ほかにも箇所があることは、数えないと
// 分からない。**
//
// そこでソースを読んで数える。箇所を足した人は、ここが赤くなって気づく。`registerCommands`
// のコマンドの数や、`activate/index` の輸出の数を固定しているのと同じ考え方である。
//
// 直し方は 2 つのどちらか。
//   - その箇所でも伏せる／戻す処理を挟み、下の一覧へ足す
//   - 挟まなくてよい理由があるなら、一覧へ足したうえでその理由をここに書く

import * as path from "path"
import { promises as fs } from "fs"

/** `src` の根。この試験は `src/services/pii/__tests__` にある。 */
const SRC = path.resolve(__dirname, "../../..")

const SKIP = [
	"__tests__",
	// プロバイダの実装そのもの。送る側ではなく、送られる側である。
	`api${path.sep}providers`,
	`api${path.sep}types.ts`,
	`api${path.sep}index.ts`,
	`api${path.sep}transform`,
	// 型を宣言しているだけ。
	`utils${path.sep}single-completion-handler.ts`,
]

async function sourceFiles(dir: string): Promise<string[]> {
	const found: string[] = []

	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue
			found.push(...(await sourceFiles(full)))
			continue
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full)
	}

	return found
}

/** `pattern` に当たる行を、`src` からの相対パスつきで集める。 */
async function callSites(pattern: RegExp): Promise<{ file: string; line: string }[]> {
	const sites: { file: string; line: string }[] = []

	for (const file of await sourceFiles(SRC)) {
		const relative = path.relative(SRC, file)
		if (SKIP.some((one) => relative.includes(one))) continue

		const lines = (await fs.readFile(file, "utf8")).split("\n")
		lines.forEach((line, index) => {
			// 説明の中の例は数えない。
			if (line.trim().startsWith("*") || line.trim().startsWith("//")) return
			if (pattern.test(line)) sites.push({ file: relative.split(path.sep).join("/"), line: `${index + 1}` })
		})
	}

	return sites
}

/** `pattern` に当たった数。行ではなく箇所を数える。 */
function count(source: string, pattern: RegExp): number {
	return [...source.matchAll(pattern)].length
}

describe("LLM へ送る呼び出し（FR-PII-01）", () => {
	it("送る箇所は 3 つだけで、どれも伏せる処理を経ている", async () => {
		const sites = await callSites(/\.createMessage\(|singleCompletionHandler\(/)

		expect(sites.map((one) => one.file).sort()).toEqual([
			// 文脈の要約。`maskForRequest` を経る。
			"core/condense/index.ts",
			// 会話の要求。`deps.maskForRequest` を経る。
			"core/task/apiRequestOrchestrator.ts",
			// 文の手直し。`maskForPrompt` を経る。
			"core/webview/messageEnhancer.ts",
		])
	})

	it.each([
		["core/task/apiRequestOrchestrator.ts", "maskForRequest"],
		["core/condense/index.ts", "maskForRequest"],
		["core/webview/messageEnhancer.ts", "maskForPrompt"],
	])("%s は %s を持つ", async (file, seam) => {
		const source = await fs.readFile(path.join(SRC, file), "utf8")

		// 語として当てる。部分一致だと、名前を変えたのに通ってしまう。
		expect(source).toMatch(new RegExp(`\\b${seam}\\b`))
	})
})

describe("ツールの引数を戻す呼び出し（FR-PII-02a）", () => {
	it("解釈する箇所は 4 つだけで、どれも戻し方を渡している", async () => {
		const sites = await callSites(
			/NativeToolCallParser\.(parseToolCall|finalizeStreamingToolCall|processStreamingChunk)\(/,
		)

		expect(sites.map((one) => one.file).sort()).toEqual([
			// 完成した呼び出し。
			"core/task/finalizeStreamingToolCalls.ts",
			"core/task/processCompleteToolCall.ts",
			// 逐次で届く呼び出し。途中の形（delta）と、完成（end）の 2 つ。
			"core/task/processToolCallPartial.ts",
			"core/task/processToolCallPartial.ts",
		])
	})

	it.each([
		"core/task/finalizeStreamingToolCalls.ts",
		"core/task/processCompleteToolCall.ts",
		"core/task/processToolCallPartial.ts",
	])("%s は、解釈する箇所の数だけ戻し方を渡す", async (file) => {
		const source = await fs.readFile(path.join(SRC, file), "utf8")

		// **数を突き合わせる。** 同じファイルに 2 箇所あると、片方だけ見ていては
		// 取りこぼしに気づけない。
		const parses = count(
			source,
			/NativeToolCallParser\.(parseToolCall|finalizeStreamingToolCall|processStreamingChunk)\(/g,
		)
		// **束縛して渡すこと。** 外すと `this` が undefined になり、ツールを呼ぶたびに
		// 例外になる。
		const bound = count(source, /unmask\?\.bind\(/g)

		expect(bound).toBe(parses)
	})
})

describe("要約を履歴へ残すとき（FR-PII-02a）", () => {
	it("残す前に戻す処理を持つ", async () => {
		const source = await fs.readFile(path.join(SRC, "core/condense/index.ts"), "utf8")

		// 伏せたまま残すと、対応表が消えたあと二度と戻せない。
		// **語として当てる。** 部分一致だと、名前を変えたのに通ってしまう。
		expect(source).toMatch(/\brestoreForHistory\b/)
	})
})
