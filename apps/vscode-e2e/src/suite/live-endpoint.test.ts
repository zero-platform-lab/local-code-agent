import * as assert from "assert"

import * as vscode from "vscode"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { waitFor } from "./utils"

/**
 * 実エンドポイントとの相性確認。`OPENAI_BASE_URL` を指定したときだけ走る。
 *
 * フェイクサーバは「こちらが理解した OpenAI 互換の仕様」でしかない。実際の
 * vLLM / Ollama / TGI / Azure は SSE の刻み方も tool_calls の分割も違うので、
 * ここが繋がることは実物でしか確かめられない。CI には鍵を置けないため、
 * リリース前に手で回す前提のテスト。
 *
 *   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_MODEL_ID=gpt-oss:20b \
 *     pnpm --filter @openai-agent/vscode-e2e test:live
 */
suite("Live endpoint", function () {
	// 実モデルは応答が遅い。ローカルの 20B 級でも数十秒かかる。
	// 2 ターン回すテストは 1 ターン分では収まらないので余裕を持たせる。
	this.timeout(900_000)

	test("drives a task to an assistant response", async function () {
		if (!process.env.OPENAI_BASE_URL) {
			this.skip()
			return
		}

		const api = globalThis.api
		const collected: ClineMessage[] = []
		api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		// タスク開始時に「ユーザーの入力」も say: text として流れてくる。
		// それを応答と取り違えないよう、本文で除外する。
		const prompt = "Reply with the attempt_completion tool. Put the word BANANA in the result."

		await api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true },
			text: prompt,
		})

		const modelReplies = () =>
			collected.filter(
				(message) =>
					!message.partial &&
					message.type === "say" &&
					(message.say === "completion_result" || message.say === "text") &&
					!!message.text &&
					message.text !== prompt,
			)

		// モデルの賢さではなく「繋がること」を見る。応答が返り、ストリームを
		// 解釈できて、UI へ流れるところまで。
		await waitFor(() => modelReplies().length > 0, { timeout: 240_000, interval: 1_000 })

		const [reply] = modelReplies()
		assert.ok(reply, "エンドポイントからの応答が UI まで届いている")

		// 何が返ってきたかは相性を判断する材料になるので残す（モデルの賢さは問わない）。
		console.log(
			`[live] say=${reply.say} tool_call=${reply.say === "completion_result"} text=${JSON.stringify(
				(reply.text ?? "").slice(0, 120),
			)}`,
		)

		// 思考の置き場所はサーバで違う（OpenAI/DeepSeek 系は reasoning_content、
		// Ollama は reasoning）。そもそも思考を出さないモデルもあるので落としはせず、
		// 届いたかどうかだけ残す。片方しか読んでいないと、ここが false になる。
		const reasoning = collected.filter((message) => message.say === "reasoning" && !!message.text)
		console.log(`[live] reasoning=${reasoning.length > 0} chunks=${reasoning.length}`)

		// 失敗の告知が出ていないこと（出ていれば繋がっていない）。
		const failure = collected.find((message) => message.say === "api_req_retry_delayed")
		assert.ok(!failure, `再試行が発生している = 相性の問題がある: ${failure?.text?.slice(0, 200)}`)
	})

	/**
	 * 実サーバの tool_calls を、実際にディスクまで届かせる。
	 *
	 * 1 本目は「応答が返る」までしか見ていない。実サーバは tool_calls の刻み方が
	 * フェイクと違う（Ollama は 1 チャンクに name も arguments もまとめて入れてくる）
	 * ので、組み立て直しが効いているかは副作用でしか確かめられない。
	 *
	 * 見るのは相性であって、モデルの賢さではない。小さいモデルはツールを呼ばずに
	 * 素の文章で答えてしまうことが実際にある（実測あり）。そこで:
	 *
	 *   - ツールを呼んだのに副作用が無い → **落とす**（こちらの組み立ての問題）
	 *   - そもそもツールを呼ばなかった   → 3 回試して駄目なら inconclusive として skip
	 *
	 * こうしておくと、失敗は必ず「拾えていない」ことを意味する。
	 */
	test("carries a real tool call through to the disk", async function () {
		if (!process.env.OPENAI_BASE_URL) {
			this.skip()
			return
		}

		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace, "テスト用ワークスペースが開かれている")

		const target = vscode.Uri.joinPath(workspace.uri, "live-tool-check.txt")

		const read = async () =>
			await vscode.workspace.fs.readFile(target).then(
				(bytes) => Buffer.from(bytes).toString("utf8"),
				() => "",
			)

		const attempts = 3

		for (let attempt = 1; attempt <= attempts; attempt++) {
			await vscode.workspace.fs.delete(target).then(undefined, () => undefined)

			const collected: ClineMessage[] = []
			globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))

			await globalThis.api.startNewTask({
				configuration: { mode: "code", autoApprovalEnabled: true, alwaysAllowWrite: true },
				text: "Use the write_to_file tool to create live-tool-check.txt with the single line BANANA. Then call attempt_completion.",
			})

			// 他のツール（list_files など）を経由することはあるので、対象ファイルへの
			// 書き込みが試みられたかどうかだけを見る。
			// 自動承認でも承認待ちでも、ツールの提示は ask/say どちらでも来る。
			// 片方しか見ないと「呼んだのに届いていない」の検査が死ぬ。
			const triedToWrite = () =>
				collected.some(
					(message) =>
						(message.say === "tool" || message.ask === "tool") &&
						!!message.text?.includes("live-tool-check.txt"),
				)
			// ファイルは先に空で作られるので、存在ではなく中身が入るまで待つ。
			//
			// 「文章が返ってきたら諦める」にはしない。gpt-oss は前置きの文章を
			// 流してからツールを呼ぶことがあり、それで打ち切ると自分のテストの
			// 都合で取りこぼす（実際に 3 回とも取りこぼした）。時間で切る。
			await waitFor(async () => (await read()).length > 0, { timeout: 90_000, interval: 1_000 }).catch(
				() => undefined,
			)

			const written = await read()
			console.log(
				`[live] tool attempt=${attempt} wrote=${JSON.stringify(written.slice(0, 60))} triedToWrite=${triedToWrite()}`,
			)

			const failure = collected.find((message) => message.say === "api_req_retry_delayed")
			assert.ok(!failure, `再試行が発生している = 相性の問題がある: ${failure?.text?.slice(0, 200)}`)

			if (written.length > 0) {
				return
			}

			// ツールを呼んだのに何も書かれていない = こちらが引数を組み立て損ねている。
			assert.ok(
				!triedToWrite(),
				"write_to_file を呼んだのにファイルへ届いていない = tool_calls の解釈が壊れている",
			)

			await globalThis.api.cancelCurrentTask().catch(() => undefined)
		}

		this.skip()
	})

	/**
	 * 2 ターン目。ここで送る messages には、1 ターン目の assistant の tool_calls と
	 * それに対する tool の結果が載る。厳密なサーバはこの組み立てが崩れていると
	 * 400 を返す。フェイクサーバは何でも受け取るので、ここは実物でしか見えない。
	 *
	 * モデルが 2 回目に何のツールを選ぶかは当てにできない（実測では
	 * attempt_completion を使わないこともある）ので、「新しい応答が返ること」と
	 * 「失敗の告知が出ないこと」だけを見る。
	 */
	test("survives a second turn that replays tool results", async function () {
		if (!process.env.OPENAI_BASE_URL) {
			this.skip()
			return
		}

		const collected: ClineMessage[] = []
		globalThis.api.on(AgentEventName.Message, ({ message }) => collected.push(message))

		const first = "Reply with the attempt_completion tool. Put the word APPLE in the result."
		const second = "Now reply again and put the word CHERRY in your answer."

		// Message イベントは同じメッセージの更新でも飛ぶ。ts で潰しておかないと、
		// 1 ターン目の応答が二重に数えられて 2 ターン目の判定が空振りする。
		const repliesByTs = () => {
			const byTs = new Map<number, ClineMessage>()

			for (const message of collected) {
				const isReply = message.say === "completion_result" || message.say === "text"

				if (!message.partial && isReply && message.text?.trim() && message.text !== first) {
					byTs.set(message.ts, message)
				}
			}

			return byTs
		}

		const requestCount = () => collected.filter((message) => message.say === "api_req_started").length

		await globalThis.api.startNewTask({
			configuration: { mode: "code", autoApprovalEnabled: true },
			text: first,
		})
		await waitFor(() => repliesByTs().size > 0, { timeout: 300_000, interval: 1_000 })

		const seen = new Set(repliesByTs().keys())
		const requestsBefore = requestCount()

		await globalThis.api.sendMessage(second)

		// 続きが実際に投げられ、新しい応答が返るところまで。400 を返すサーバなら
		// ここまで来ない。
		//
		// ただしモデルが 1 ターン目をどう終えるかで到達しないことがある（実測あり）。
		// 到達しなかったときは inconclusive として扱う。ここを失敗にすると、
		// モデルの気分でゲートの色が変わるテストになる。再開そのものの結線は
		// `round-trip.test.ts` がフェイクサーバ相手に決定論的に見ている。
		const reached = await waitFor(
			() => requestCount() > requestsBefore && [...repliesByTs().keys()].some((ts) => !seen.has(ts)),
			{ timeout: 300_000, interval: 1_000 },
		).then(
			() => true,
			() => false,
		)

		const stalled = collected.find((message) => message.say === "api_req_retry_delayed" || message.say === "error")

		if (!reached) {
			console.log(
				`[live] turn2 到達せず requests=${requestCount() - requestsBefore} tail=` +
					JSON.stringify(
						collected
							.filter((message) => !message.partial)
							.slice(-6)
							.map((message) => `${message.type}/${message.ask ?? message.say}`),
					),
			)
			// 失敗の告知が出ているなら、それは相性の問題なので落とす。
			assert.ok(!stalled, `2 ターン目で失敗している: ${stalled?.text?.slice(0, 300)}`)
			this.skip()
			return
		}

		const fresh = [...repliesByTs().entries()].filter(([ts]) => !seen.has(ts)).map(([, message]) => message)
		console.log(
			`[live] turn2 replies=${fresh.length} say=${fresh[0]?.say} text=${JSON.stringify(
				(fresh[0]?.text ?? "").slice(0, 80),
			)}`,
		)

		// 400 / 500 が返っていれば拡張は再試行を告知する。履歴の組み立てが
		// 崩れていればここで出る。
		const failure = collected.find((message) => message.say === "api_req_retry_delayed" || message.say === "error")
		assert.ok(
			!failure,
			`2 ターン目で失敗している = 履歴の組み立てに相性の問題がある: ${failure?.text?.slice(0, 300)}`,
		)
	})
})
