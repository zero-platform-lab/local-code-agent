import * as assert from "assert"

import * as vscode from "vscode"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * 鍵を必要としない 1 往復。フェイクの OpenAI 互換サーバを相手に、
 *
 *   webview からの起動 → 拡張 → HTTP リクエスト → SSE のストリーム解釈 →
 *   タスクループ（ツール呼び出しの実行）→ UI メッセージ
 *
 * が繋がっていることを固定する。単体テストはこの経路をどこかで必ずモックするため、
 * ここが切れていても気付けない。
 */
suite("Round trip against the fake endpoint", function () {
	setDefaultSuiteTimeout(this)

	const messagesOf = (collected: ClineMessage[], say: string) =>
		collected.filter((message) => message.type === "say" && message.say === say && !message.partial)

	test("carries a tool call from the endpoint through to the completion message", async () => {
		const api = globalThis.api
		const fake = globalThis.fakeOpenAiServer

		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		fake.enqueue({
			kind: "tool",
			name: "attempt_completion",
			arguments: { result: "The round trip works." },
		})

		const before = fake.requests.length

		const collected: ClineMessage[] = []
		api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true },
			text: "Say that the round trip works.",
		})

		await waitFor(() => messagesOf(collected, "completion_result").length > 0, { timeout: 60_000 })

		const [completion] = messagesOf(collected, "completion_result")
		assert.ok(completion, "完了メッセージが届いている")
		assert.strictEqual(
			completion.text,
			"The round trip works.",
			"エンドポイントが返した tool の引数がそのまま完了メッセージになる",
		)

		// 送った側も確認する。system prompt とツール定義が実際に載っていること。
		const requests = fake.requests.slice(before)
		assert.strictEqual(requests.length, 1, "1 往復で終わる")
		const [request] = requests
		assert.ok(request, "リクエストが記録されている")
		assert.strictEqual(request.model, "mock-model")
		assert.ok(request.systemPrompt && request.systemPrompt.length > 0, "system prompt が送られている")
		assert.ok(
			request.toolNames.includes("attempt_completion"),
			`ツール定義が送られている: ${request.toolNames.join(", ")}`,
		)
		assert.ok(
			JSON.stringify(request.messages).includes("Say that the round trip works."),
			"ユーザーの入力が messages に載っている",
		)
	})

	test("runs the tool the endpoint asked for and feeds its result back", async () => {
		const api = globalThis.api
		const fake = globalThis.fakeOpenAiServer

		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace, "テスト用ワークスペースが開かれている")

		const marker = `ROUND-TRIP-MARKER-${Date.now()}`
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(workspace.uri, "round-trip-fixture.txt"),
			Buffer.from(`${marker}\n`, "utf8"),
		)

		const before = fake.requests.length

		// 1 回目でファイルを読ませ、その結果を受けて 2 回目で完了させる。
		fake.enqueue(
			{ kind: "tool", name: "read_file", arguments: { path: "round-trip-fixture.txt" } },
			{ kind: "tool", name: "attempt_completion", arguments: { result: "I read the file." } },
		)

		const collected: ClineMessage[] = []
		api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true, alwaysAllowReadOnly: true },
			text: "Read round-trip-fixture.txt and tell me you did.",
		})

		await waitFor(() => collected.some((message) => message.say === "completion_result" && !message.partial), {
			timeout: 60_000,
		})

		const requests = fake.requests.slice(before)
		assert.strictEqual(requests.length, 2, "ツール実行を挟んで 2 往復する")

		// 2 回目のリクエストに、実際にディスクから読んだ中身が載っていること。
		// ここが載っていなければ、ツールが動いていないか結果が戻っていない。
		const [, second] = requests
		assert.ok(second, "2 回目のリクエストが記録されている")
		assert.ok(
			JSON.stringify(second.messages).includes(marker),
			"読み取ったファイルの中身が次のリクエストに含まれている",
		)
	})

	/**
	 * ユーザーが完了後に続きを送る経路。会話履歴には 1 ターン目の assistant の
	 * tool_calls とその結果が載ったまま次のリクエストへ回る。実サーバ相手だと
	 * モデルが何を返すか当てにできず判定が揺れるので、決定論的に見るのはここ。
	 */
	test("continues the same task when the user sends a follow-up", async () => {
		const api = globalThis.api
		const fake = globalThis.fakeOpenAiServer

		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const before = fake.requests.length

		fake.enqueue({ kind: "tool", name: "attempt_completion", arguments: { result: "first answer" } })

		const collected: ClineMessage[] = []
		api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await api.startNewTask({
			configuration: { mode: "ask", autoApprovalEnabled: true },
			text: "First question.",
		})
		await waitFor(() => messagesOf(collected, "completion_result").some((m) => m.text === "first answer"), {
			timeout: 60_000,
		})

		fake.enqueue({ kind: "tool", name: "attempt_completion", arguments: { result: "second answer" } })
		await api.sendMessage("Second question.")

		await waitFor(() => messagesOf(collected, "completion_result").some((m) => m.text === "second answer"), {
			timeout: 60_000,
		})

		const requests = fake.requests.slice(before)
		assert.ok(requests.length >= 2, `続きの送信で 2 回目のリクエストが飛ぶ: ${requests.length}`)

		// 2 回目には、1 ターン目の応答と今回の入力の両方が載っている。
		// ここが欠けていると、実サーバは履歴の不整合として弾く。
		const second = JSON.stringify(requests[1]?.messages)
		assert.ok(second.includes("Second question."), "続きの入力が messages に載っている")
		assert.ok(second.includes("first answer"), "1 ターン目のツール結果が messages に残っている")
	})
})
