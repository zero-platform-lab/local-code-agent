import * as assert from "assert"

import * as vscode from "vscode"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * うまくいかない道。既存の e2e は成功経路しか通っておらず、失敗時の振る舞いは
 * 無検査だった。壊れても気付きにくいのはむしろこちら側。
 */
suite("Failure paths against the fake endpoint", function () {
	setDefaultSuiteTimeout(this)

	const collectMessages = () => {
		const collected: ClineMessage[] = []
		globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))
		return collected
	}

	test("retries after an endpoint error and recovers", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const before = fake.requests.length

		// 1 回目は 500、2 回目は成功。自動再試行で回復できること。
		fake.enqueue(
			{ kind: "error", status: 500, message: "fake upstream is down" },
			{ kind: "tool", name: "attempt_completion", arguments: { result: "recovered" } },
		)

		const collected = collectMessages()

		await globalThis.api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true } as never,
			text: "This request will fail once.",
		})

		await waitFor(
			() =>
				collected.some(
					(message) =>
						message.say === "completion_result" && !message.partial && message.text === "recovered",
				),
			{ timeout: 60_000 },
		)

		assert.strictEqual(fake.requests.length - before, 2, "失敗した分を投げ直している")

		// 一時的な失敗は SDK 側の再送で吸収され、ユーザーの手を止めない。
		assert.ok(
			!collected.some((message) => message.type === "ask" && message.ask === "api_req_failed"),
			"一時的な失敗でユーザーに判断を求めない",
		)
	})

	test("keeps telling the user why while the endpoint stays down", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		// 落ち続ける状況。SDK の再送でも吸収しきれず、タスク側の再試行に入る。
		for (let i = 0; i < 8; i++) {
			fake.enqueue({ kind: "error", status: 503, message: "still down" })
		}

		const collected = collectMessages()

		await globalThis.api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true } as never,
			text: "This endpoint stays down.",
		})

		// 黙って固まらず、理由付きで再試行を知らせ続けること。
		await waitFor(() => collected.some((message) => message.say === "api_req_retry_delayed"), { timeout: 60_000 })

		const notice = collected.find((message) => message.say === "api_req_retry_delayed")
		assert.ok(notice, "再試行の告知が出ている")
		assert.ok((notice.text ?? "").includes("still down"), `エンドポイントが返した理由が載っている: ${notice.text}`)

		// 後続テストへ持ち越さないよう、再試行し続けるタスクをここで畳む。
		await globalThis.api.cancelCurrentTask()
		fake.clearQueue()

		// キャンセルが実際に効いてリクエストが止まるまで待つ。止まる前に次のテストへ
		// 進むと、そちらの「何往復したか」の勘定に紛れ込む。
		let previous = -1
		await waitFor(
			() => {
				const current = fake.requests.length
				const stopped = current === previous
				previous = current
				return stopped
			},
			{ timeout: 30_000, interval: 1_000 },
		)
	})

	test("keeps the file untouched when the diff does not match, and reports why", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace, "テスト用ワークスペースが開かれている")

		const original = "one\ntwo\nthree\n"
		const target = vscode.Uri.joinPath(workspace.uri, "e2e-mismatch.txt")
		await vscode.workspace.fs.writeFile(target, Buffer.from(original, "utf8"))

		const before = fake.requests.length

		fake.enqueue(
			{
				kind: "tool",
				name: "apply_diff",
				arguments: {
					path: "e2e-mismatch.txt",
					diff: [
						"<<<<<<< SEARCH",
						":start_line:2",
						"-------",
						"THIS LINE DOES NOT EXIST",
						"=======",
						"replacement",
						">>>>>>> REPLACE",
					].join("\n"),
				},
			},
			{ kind: "tool", name: "attempt_completion", arguments: { result: "gave up" } },
		)

		const collected = collectMessages()

		await globalThis.api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true, alwaysAllowWrite: true } as never,
			text: "Apply a diff that will not match.",
		})

		await waitFor(() => collected.some((message) => message.say === "completion_result" && !message.partial), {
			timeout: 60_000,
		})

		// 失敗しても元のファイルを壊さない。
		const after = Buffer.from(await vscode.workspace.fs.readFile(target)).toString("utf8")
		assert.strictEqual(after, original, "一致しなかったときはファイルを変更しない")

		// 失敗の理由がモデルへ戻っている（次の判断材料になる）。
		const requests = fake.requests.slice(before)
		assert.ok(requests.length >= 2, "失敗を伝えるための次のリクエストがある")
		const [, second] = requests
		assert.ok(second, "2 回目のリクエストが記録されている")
		assert.ok(
			JSON.stringify(second.messages).includes("No sufficiently similar match"),
			"一致しなかった理由が会話へ戻っている",
		)
	})

	test("reports a non-zero exit code back to the model", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const before = fake.requests.length

		fake.enqueue(
			{ kind: "tool", name: "execute_command", arguments: { command: "exit 3", cwd: null, timeout: null } },
			{ kind: "tool", name: "attempt_completion", arguments: { result: "noticed the failure" } },
		)

		const collected = collectMessages()

		await globalThis.api.startNewTask({
			configuration: {
				mode: "code",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["exit"],
			} as never,
			text: "Run a command that fails.",
		})

		await waitFor(() => collected.some((message) => message.say === "completion_result" && !message.partial), {
			timeout: 60_000,
		})

		const requests = fake.requests.slice(before)
		assert.ok(requests.length >= 2, "コマンド失敗を伝えるための次のリクエストがある")
		const [, second] = requests
		assert.ok(second, "2 回目のリクエストが記録されている")
		const conversation = JSON.stringify(second.messages)
		assert.ok(conversation.includes("Exit code: 3"), "終了コードがモデルへ伝わっている")
	})
})
