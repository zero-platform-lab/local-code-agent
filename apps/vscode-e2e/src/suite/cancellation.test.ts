import * as assert from "assert"
import { execFileSync } from "child_process"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

/**
 * ツールの実行中に止められること。
 *
 * 以前は、止めてもタスクの後片付けが実行中のコマンドを止めず、ツールはコマンドが
 * 終わるまで待ち続けた。画面の停止ボタンも、LLM の応答の受信中しか出ていなかった。
 * 自動承認や Autopilot では、止める手段が無いまま動き続けていた。
 *
 * 止めるのは `api.cancelCurrentTask()`。画面の停止ボタンと同じ `cancelTask` の経路である。
 */
suite("Cancelling while a tool is running", function () {
	setDefaultSuiteTimeout(this)

	const collectMessages = () => {
		const collected: ClineMessage[] = []
		globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))
		return collected
	}

	/** 一意の秒数を持つ sleep。ps で、このテストが起こしたプロセスだけを数えられる。 */
	const uniqueSleep = () => `sleep 2${Math.floor(Math.random() * 90_000) + 10_000}.5`

	const isRunning = (command: string) => {
		try {
			execFileSync("pgrep", ["-f", command])
			return true
		} catch {
			return false
		}
	}

	const waitUntilAborted = () =>
		new Promise<number>((resolve) => {
			const startedAt = Date.now()
			globalThis.api.once(AgentEventName.TaskAborted, () => resolve(Date.now() - startedAt))
		})

	const cancelDuringCommand = async (configuration: Record<string, unknown>, label: string) => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		const command = uniqueSleep()
		fake.clearQueue()
		fake.enqueue(
			{ kind: "tool", name: "execute_command", arguments: { command, cwd: null, timeout: null } },
			// 止まらなければ、コマンドの後でこれを受け取って完了してしまう。
			{ kind: "tool", name: "attempt_completion", arguments: { result: "SHOULD-NOT-COMPLETE" } },
		)

		const collected = collectMessages()
		await globalThis.api.startNewTask({ configuration: configuration as never, text: `Run ${command}.` })

		// コマンドが実際に動き出すまで待つ。ここで LLM の応答はもう終わっている。
		await waitFor(() => isRunning(command), { timeout: 60_000 })
		const requestsBeforeCancel = fake.requests.length

		const aborted = waitUntilAborted()
		await globalThis.api.cancelCurrentTask()
		const elapsed = await aborted

		// 止める操作から abort までが、コマンドの長さ（数十時間）に引きずられないこと。
		assert.ok(elapsed < 15_000, `${label}: 止めてから abort まで ${elapsed}ms`)

		// コマンドのプロセスが消えること。後片付けで紐付けを外すだけでは残る。
		await waitFor(() => !isRunning(command), { timeout: 15_000 })

		// 止めた後に LLM へ続きを頼まないこと。少し待って数が増えないことを見る。
		await new Promise((resolve) => setTimeout(resolve, 3_000))
		assert.strictEqual(fake.requests.length, requestsBeforeCancel, `${label}: 止めた後にリクエストが出ていない`)
		assert.ok(
			!collected.some((message) => message.say === "completion_result"),
			`${label}: 止めたタスクが完了まで進んでいない`,
		)

		fake.clearQueue()
	}

	test("Auto で、バックグラウンド実行（execa）のコマンドを止める", async () => {
		await cancelDuringCommand(
			{
				mode: "code",
				autonomyMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["sleep"],
				terminalShellIntegrationDisabled: true,
			},
			"auto/execa",
		)
	})

	test("Auto で、VS Code のターミナルで動くコマンドを止める", async () => {
		await cancelDuringCommand(
			{
				mode: "code",
				autonomyMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["sleep"],
				terminalShellIntegrationDisabled: false,
			},
			"auto/vscode-terminal",
		)
	})

	test("Autopilot（人に聞く場面が無い）で、許可の一覧に無いコマンドを止める", async () => {
		await cancelDuringCommand(
			{
				mode: "code",
				autonomyMode: "autopilot",
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				alwaysAllowMcp: true,
				alwaysAllowSubtasks: true,
				allowedCommands: [],
				terminalShellIntegrationDisabled: true,
			},
			"autopilot/execa",
		)
	})

	test("止めた後に始めたタスクは、最後まで終わる", async () => {
		const fake = globalThis.fakeOpenAiServer
		assert.ok(fake, "フェイクサーバが必要（OPENAI_BASE_URL を設定した実行では対象外）")

		// 1 つ目を実行中に止める
		await cancelDuringCommand(
			{
				mode: "code",
				autonomyMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["sleep"],
				terminalShellIntegrationDisabled: true,
			},
			"before-recovery",
		)

		// 2 つ目は普通に完了する。止めたときの状態が残って邪魔をしないこと。
		const marker = `RECOVERED-${Date.now()}`
		fake.enqueue({ kind: "tool", name: "attempt_completion", arguments: { result: marker } })
		const collected = collectMessages()
		await globalThis.api.startNewTask({
			configuration: { mode: "code", autonomyMode: "auto", autoApprovalEnabled: true } as never,
			text: "Finish right away.",
		})

		await waitFor(
			() =>
				collected.some(
					(message) =>
						message.say === "completion_result" && !message.partial && message.text?.includes(marker),
				),
			{ timeout: 60_000 },
		)
	})
})
