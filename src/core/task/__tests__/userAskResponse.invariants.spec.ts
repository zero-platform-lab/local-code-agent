// npx vitest run core/task/__tests__/userAskResponse.invariants.spec.ts
//
// ask への応答を渡す 2 つの入口について、呼び出し箇所の数を固定する。
//
//   - `handleUserAskResponse`: 人が応答した経路。繰り返しの判定（ToolRepetitionDetector）の
//     回数を 0 に戻してから応答を渡す
//   - `handleWebviewAskResponse`: 回数を残したまま応答を渡す。自動承認・自動拒否が使う
//
// **入口を取り違えると、どちらの向きでも単体の試験では見つからない。**
//   - 人の経路が `handleWebviewAskResponse` を呼ぶと、人が割り込んだ後も回数が残り、
//     正当な繰り返しを止めてしまう（この修正の前の状態）
//   - 自動の経路が `handleUserAskResponse` を呼ぶと、自動で拒否され続けるループでも
//     回数が毎回 0 に戻り、繰り返しの判定が二度と止めなくなる
//
// 経路を足した人は、ここが赤くなって気づく。人の操作から来るなら上の一覧へ、
// 自動なら下の一覧へ足す。

import * as path from "path"
import { promises as fs } from "fs"

/** `src` の根。この試験は `src/core/task/__tests__` にある。 */
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

/** `pattern` に当たる呼び出しのファイルを、箇所の数だけ並べて返す。 */
async function callSites(pattern: RegExp): Promise<string[]> {
	const sites: string[] = []

	for (const file of await sourceFiles(SRC)) {
		const relative = path.relative(SRC, file).split(path.sep).join("/")
		for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
			// 説明の中の例は数えない。
			if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue
			for (const _ of line.matchAll(pattern)) sites.push(relative)
		}
	}

	return sites.sort()
}

describe("ask への応答の入口", () => {
	it("人が応答した経路は 4 つで、どれも handleUserAskResponse を呼ぶ", async () => {
		expect(await callSites(/\.handleUserAskResponse\(/g)).toEqual([
			// キューに入れたメッセージで、待っている ask に答える
			"core/task/drainQueuedMessageForAsk.ts",
			// 入力欄から送ったメッセージ（キューの消化と拡張の API もここを通る）
			"core/task/submitUserMessage.ts",
			// 過去のメッセージを編集して送り直す
			"core/webview/replayPendingEdit.ts",
			// 画面のボタン（承認・却下）と、ask への返答
			"core/webview/taskMessageHandlers.ts",
		])
	})

	it("回数を残す入口を呼ぶのは、自動承認と Task 自身だけ", async () => {
		expect(await callSites(/\.handleWebviewAskResponse\(/g)).toEqual([
			// approveAsk・denyAsk（自動承認・自動拒否が呼ぶ）と、handleUserAskResponse の中
			"core/task/Task.ts",
			"core/task/Task.ts",
			"core/task/Task.ts",
			// 自動の返事（Autopilot が質問に答える "respond"）
			"core/task/applyAutoApprovalDecision.ts",
		])
	})
})
