// npx vitest run core/webview/__tests__/webviewDiagnostics.invariants.spec.ts
//
// 状態を Webview へ送る箇所の数を固定する。
//
// 送るたびに大きさをログへ残すのは、白い画面の原因（送る量が多すぎる）を数字で確かめるため
// である。`{ type: "state" }` を直接送る箇所が 1 つでも増えると、その経路の送信だけが
// ログに出ず、調べたつもりで見落とす。経路を足した人は、ここが赤くなって気づく。
// 足すなら `provider.postStateMessage(...)` を使い、下の一覧へ加える。

import * as path from "path"
import { promises as fs } from "fs"

/** `src` の根。この試験は `src/core/webview/__tests__` にある。 */
const SRC = path.resolve(__dirname, "../../..")

async function sourceFiles(dir: string): Promise<string[]> {
	const found: string[] = []

	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (["node_modules", "dist", "coverage", "__tests__"].includes(entry.name)) continue
			found.push(...(await sourceFiles(full)))
			continue
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full)
	}

	return found
}

/** `pattern` に当たる箇所のファイルを、箇所の数だけ並べて返す。説明の中の例は数えない。 */
async function callSites(pattern: RegExp): Promise<string[]> {
	const sites: string[] = []

	for (const file of await sourceFiles(SRC)) {
		const relative = path.relative(SRC, file).split(path.sep).join("/")
		for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
			if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue
			for (const _ of line.matchAll(pattern)) sites.push(relative)
		}
	}

	return sites.sort()
}

describe("状態を Webview へ送る経路", () => {
	it('`type: "state"` を送るのは postStateWithDiagnostics だけ', async () => {
		expect(await callSites(/type:\s*"state"/g)).toEqual(["core/webview/webviewDiagnostics.ts"])
	})

	it("postStateMessage を呼ぶのは 4 箇所", async () => {
		expect(await callSites(/\.postStateMessage\(/g)).toEqual([
			// postStateToWebview・WithoutTaskHistory・WithoutClineMessages
			"core/webview/ClineProvider.ts",
			"core/webview/ClineProvider.ts",
			"core/webview/ClineProvider.ts",
			// プロンプトを保存した直後の状態
			"core/webview/promptMessageHandlers.ts",
		])
	})
})
