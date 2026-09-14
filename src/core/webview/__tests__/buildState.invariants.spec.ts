// npx vitest run core/webview/__tests__/buildState.invariants.spec.ts
//
// `buildState` が、画面の要る設定を 1 つも落としていないことを固定する。
//
// **この試験を書いた理由。** `piiMasking` と `skillSources` を `buildState` に書き落として
// いた。`buildExtensionState` はそれを取り出そうとするが、いつも `undefined` になる。
// 画面は設定が無いものとして描くので、
//
//   - 右下の切り替えが常に「切」に見え、押しても入にしかならない（消せない）
//   - 設定の画面でチェックしても、開き直すと戻る
//
// という形で表に出た。**型では気づけない。** どちらも省略できる型なので、返さなくても
// 通る。数えないと分からない。

import * as path from "path"
import { promises as fs } from "fs"

const SRC = path.resolve(__dirname, "../../..")

/** `buildExtensionState` が `state` から取り出す名前。 */
async function forwarded(): Promise<string[]> {
	const source = await fs.readFile(path.join(SRC, "core/webview/buildExtensionState.ts"), "utf8")
	const block = /export function buildExtensionState[\s\S]*?\}\s*=\s*state/.exec(source)
	if (!block) throw new Error("buildExtensionState の取り出しが読めない")

	return [...block[0].matchAll(/^\t\t([a-zA-Z][a-zA-Z0-9]*),$/gm)].map((one) => one[1])
}

/** `buildState` が返り値へ入れている名前。 */
async function returned(): Promise<string[]> {
	const source = await fs.readFile(path.join(SRC, "core/webview/buildState.ts"), "utf8")
	const block = /export function buildState[\s\S]*$/.exec(source)
	if (!block) throw new Error("buildState が読めない")

	return [...block[0].matchAll(/^\t\t([a-zA-Z][a-zA-Z0-9]*):/gm)].map((one) => one[1])
}

describe("画面へ渡す設定を落とさない", () => {
	it("buildExtensionState が取り出すものは、全部 buildState が返す", async () => {
		const [wanted, given] = await Promise.all([forwarded(), returned()])

		// `extras` から来るものは `buildState` の引数で受けるので、ここでは数えない。
		const fromExtras = new Set(["apiConfiguration", "taskHistory", "cwd"])
		const missing = wanted.filter((one) => !fromExtras.has(one) && !given.includes(one))

		expect(missing, `画面へ渡していない設定: ${missing.join(", ")}`).toEqual([])
	})

	it("読み取り自体が空振りしていない", async () => {
		// 正規表現が当たらなくなると、上の試験がいつでも通ってしまう。
		expect((await forwarded()).length).toBeGreaterThan(30)
		expect((await returned()).length).toBeGreaterThan(30)
	})
})
