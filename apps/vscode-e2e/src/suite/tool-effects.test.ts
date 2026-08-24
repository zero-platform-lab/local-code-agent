import * as assert from "assert"

import * as vscode from "vscode"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * 副作用のあるツールを、フェイクのエンドポイント越しに実際に走らせる。
 *
 * `round-trip.test.ts` が守るのは「送って・受けて・戻す」の結線までで、
 * ツールが**実際にディスクやシェルへ届いているか**は見ていない。ここはその 1 段先。
 */
suite("Tool side effects against the fake endpoint", function () {
	setDefaultSuiteTimeout(this)

	const workspaceUri = () => {
		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace, "テスト用ワークスペースが開かれている")
		return workspace.uri
	}

	const runUntilCompleted = async (configuration: Record<string, unknown>, text: string): Promise<ClineMessage[]> => {
		const collected: ClineMessage[] = []
		globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await globalThis.api.startNewTask({ configuration: configuration as never, text })

		await waitFor(() => collected.some((message) => message.say === "completion_result" && !message.partial), {
			timeout: 60_000,
		})

		return collected
	}

	test("writes the file the endpoint asked for", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const marker = `WRITTEN-BY-E2E-${Date.now()}`
		const target = vscode.Uri.joinPath(workspaceUri(), "e2e-created.txt")

		fake.enqueue(
			{ kind: "tool", name: "write_to_file", arguments: { path: "e2e-created.txt", content: `${marker}\n` } },
			{ kind: "tool", name: "attempt_completion", arguments: { result: "wrote it" } },
		)

		await runUntilCompleted(
			{ mode: "code", autoApprovalEnabled: true, alwaysAllowWrite: true },
			"Create e2e-created.txt.",
		)

		// ディスクに実際に書かれていること。ここが本命。
		const written = Buffer.from(await vscode.workspace.fs.readFile(target)).toString("utf8")
		assert.ok(written.includes(marker), `書き込まれた内容: ${JSON.stringify(written)}`)
	})

	test("applies a surgical diff to an existing file", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const marker = `PATCHED-${Date.now()}`
		const target = vscode.Uri.joinPath(workspaceUri(), "e2e-patch-target.txt")
		await vscode.workspace.fs.writeFile(target, Buffer.from("alpha\nbravo\ncharlie\n", "utf8"))

		fake.enqueue(
			{
				kind: "tool",
				name: "apply_diff",
				arguments: {
					path: "e2e-patch-target.txt",
					diff: [
						"<<<<<<< SEARCH",
						":start_line:2",
						"-------",
						"bravo",
						"=======",
						marker,
						">>>>>>> REPLACE",
					].join("\n"),
				},
			},
			{ kind: "tool", name: "attempt_completion", arguments: { result: "patched" } },
		)

		await runUntilCompleted(
			{ mode: "code", autoApprovalEnabled: true, alwaysAllowWrite: true },
			"Patch the second line.",
		)

		const patched = Buffer.from(await vscode.workspace.fs.readFile(target)).toString("utf8")
		assert.ok(patched.includes(marker), `置換後: ${JSON.stringify(patched)}`)
		// 触っていない行は残っていること（丸ごと書き換えていない）。
		assert.ok(patched.includes("alpha"), "前の行が残っている")
		assert.ok(patched.includes("charlie"), "後の行が残っている")
		assert.ok(!patched.includes("bravo"), "置換元が消えている")
	})

	test("delegates to a subtask and brings its result back to the parent", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const childMarker = `CHILD-RESULT-${Date.now()}`
		const before = fake.requests.length

		fake.enqueue(
			// 親: サブタスクへ委譲する
			{
				kind: "tool",
				name: "new_task",
				arguments: { mode: "code", message: "Do the small thing.", todos: null },
			},
			// 子: 結果を返して終わる
			{ kind: "tool", name: "attempt_completion", arguments: { result: childMarker } },
			// 親: 子の結果を受けて終わる
			{ kind: "tool", name: "attempt_completion", arguments: { result: "parent done" } },
		)

		const collected: ClineMessage[] = []
		globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		await globalThis.api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true, alwaysAllowSubtasks: true } as never,
			text: "Delegate the small thing.",
		})

		await waitFor(() => fake.requests.length - before >= 3, { timeout: 60_000 })

		const requests = fake.requests.slice(before)
		assert.strictEqual(requests.length, 3, "親 → 子 → 親 の 3 往復になる")

		// 3 回目（親に戻ってきた側）に、子が返した結果が載っていること。
		const [, , third] = requests
		assert.ok(third, "3 回目のリクエストが記録されている")
		assert.ok(JSON.stringify(third.messages).includes(childMarker), "子タスクの結果が親の会話へ戻っている")
	})

	test("recovers when the endpoint asks for a tool that does not exist", async () => {
		// switch_mode は PR #19 で削除した。モデル（＝エンドポイント）が削除済みツールを
		// 要求してきても、タスクが止まらずエラーを伝えて完了まで進めることを検証する。
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		fake.enqueue(
			{
				kind: "tool",
				name: "switch_mode",
				arguments: { mode_slug: "architect", reason: "planning first" },
			},
			{ kind: "tool", name: "attempt_completion", arguments: { result: "recovered" } },
		)

		await runUntilCompleted({ mode: "code", autoApprovalEnabled: true }, "Try to switch modes.")

		// モードは変わらないこと。
		assert.strictEqual(globalThis.api.getConfiguration().mode, "code")
	})

	test("runs the command the endpoint asked for and feeds its output back", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const marker = `COMMAND-OUTPUT-${Date.now()}`
		const before = fake.requests.length

		fake.enqueue(
			{
				kind: "tool",
				name: "execute_command",
				arguments: { command: `echo ${marker}`, cwd: null, timeout: null },
			},
			{ kind: "tool", name: "attempt_completion", arguments: { result: "ran it" } },
		)

		await runUntilCompleted(
			{
				mode: "code",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["echo"],
			},
			"Print the marker.",
		)

		const requests = fake.requests.slice(before)
		assert.strictEqual(requests.length, 2, "コマンド実行を挟んで 2 往復する")

		const [, second] = requests
		assert.ok(second, "2 回目のリクエストが記録されている")
		assert.ok(JSON.stringify(second.messages).includes(marker), "コマンドの出力が次のリクエストに含まれている")
	})
})
