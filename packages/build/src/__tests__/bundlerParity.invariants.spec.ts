// npx vitest run src/__tests__/bundlerParity.invariants.spec.ts
//
// 2 つの束ね方の設定が、第 2 層について同じものを使っていることを固定する。
//
// **この試験を書いた理由。** `src/esbuild.mjs` にだけ第 2 層の設定を入れ、配布に使う
// `apps/vscode-internal/esbuild.mjs` を直し忘れた。片方では動くのに、配ったものでは
// 第 2 層が黙って動かない。例外は握られるので、画面には何も出ない。
//
// **最初は grep で揃っているかを見ていた。それは後追いでしかない。** 覚えていた型しか
// 見ないので、次のずれは通る。いまは設定そのものを `piiRuntimeBundle` へ切り出し、
// 両方がそれを呼ぶ形にしてある。ここで固定するのは「呼んでいること」だけでよい。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import { piiRuntimeBundle } from "../esbuild.js"

const ROOT = path.resolve(__dirname, "../../../..")

const CONFIGS = ["src/esbuild.mjs", "apps/vscode-internal/esbuild.mjs"]

describe("束ね方の設定が同じものを使う", () => {
	it("設定は 2 つだけである", async () => {
		// 足りたら、この試験の一覧へ足す。足さないと同じ取りこぼしが起きる。
		const found: string[] = []
		const walk = async (at: string): Promise<void> => {
			for (const entry of await fs.readdir(at, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue
				const full = path.join(at, entry.name)
				if (entry.isDirectory()) await walk(full)
				// **区切り文字を揃える。** 揃えないと Windows でだけ落ちる。
				else if (entry.name === "esbuild.mjs") found.push(path.relative(ROOT, full).split(path.sep).join("/"))
			}
		}
		for (const dir of ["src", "apps"]) await walk(path.join(ROOT, dir))

		expect(found.sort()).toEqual([...CONFIGS].sort())
	})

	it.each(CONFIGS)("%s は piiRuntimeBundle を使う", async (config) => {
		const source = await fs.readFile(path.join(ROOT, config), "utf8")

		// **語として当てる。** 部分一致だと、名前を変えたのに通ってしまう。
		expect(source).toMatch(/\bpiiRuntimeBundle\(/)
		expect(source).toMatch(/\bpii\.plugin\b/)
		expect(source).toMatch(/\.\.\.pii\.external\b/)
		expect(source).toMatch(/\bpii\.alias\b/)
	})
})

describe("piiRuntimeBundle が返すもの", () => {
	const parts = (target?: string) =>
		piiRuntimeBundle({ srcDir: path.join(os.tmpdir(), "src"), distDir: path.join(os.tmpdir(), "dist"), target })

	it("native は束ねずに外へ出す", () => {
		// 束ねると相対の位置がずれて、実行ファイルが見つからない。
		expect(parts().external).toContain("onnxruntime-node")
	})

	it("画像用は代用に差し替える", () => {
		// 本物を同梱すると 16.5 MB 増える。中身は使わない。
		expect(parts().alias.sharp).toMatch(/build-stubs[/\\]sharp\.js$/)
	})

	it("写す処理を持つ", () => {
		expect(parts().plugin.name).toBe("copyOnnxRuntime")
	})
})
