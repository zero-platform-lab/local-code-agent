// npx vitest run src/__tests__/bundlerParity.invariants.spec.ts
//
// 2 つの束ね方の設定が、第 2 層について同じ扱いをしていることを固定する。
//
// **この試験を書いた理由。** `src/esbuild.mjs` にだけ第 2 層の設定を入れ、配布に使う
// `apps/vscode-internal/esbuild.mjs` を直し忘れた。片方では動くのに、配ったものでは
// 第 2 層が黙って動かない。例外は握られるので、画面には何も出ない。
//
// 設定が 2 つあることは、どちらかを読んでいる限り気づけない。**数えないと分からない。**

import * as path from "path"
import { promises as fs } from "fs"

const ROOT = path.resolve(__dirname, "../../../..")

const CONFIGS = ["src/esbuild.mjs", "apps/vscode-internal/esbuild.mjs"]

/** 第 2 層が動くために、どちらの設定にも要るもの。 */
const REQUIRED = [
	// native は束ねられない。外に出して `dist/node_modules` から読む。
	{ what: "onnxruntime-node を外に出す", pattern: /external:[^\]]*"onnxruntime-node"/s },
	// 画像用の本物を同梱しない（16.5 MB）。
	{ what: "sharp を代用に差し替える", pattern: /alias:[\s\S]{0,120}sharp/ },
	// native を写す。写さないと読み込みで失敗する。
	{ what: "onnxruntime を写す", pattern: /copyOnnxRuntime\(/ },
	// 配る先を受ける。受けないと、作った機械のぶんだけが入る。
	{ what: "target を受け取る", pattern: /--target=/ },
]

describe("束ね方の設定が揃っている", () => {
	it("設定は 2 つだけである", async () => {
		// 足りたら、この試験の一覧へ足す。足さないと同じ取りこぼしが起きる。
		const found: string[] = []
		for (const dir of ["src", "apps"]) {
			const walk = async (at: string): Promise<void> => {
				for (const entry of await fs.readdir(at, { withFileTypes: true })) {
					if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue
					const full = path.join(at, entry.name)
					if (entry.isDirectory()) await walk(full)
					else if (entry.name === "esbuild.mjs") found.push(path.relative(ROOT, full))
				}
			}
			await walk(path.join(ROOT, dir))
		}

		expect(found.sort()).toEqual([...CONFIGS].sort())
	})

	it.each(CONFIGS.flatMap((config) => REQUIRED.map((one) => [config, one.what, one.pattern] as const)))(
		"%s は %s",
		async (config, _what, pattern) => {
			expect(await fs.readFile(path.join(ROOT, config), "utf8")).toMatch(pattern)
		},
	)
})
