// npx vitest run extension/__tests__/api.invariants.spec.ts
//
// extension/api.ts は拡張の **公開 API**（IPC ソケット経由でも叩ける）。C0 24.1% /
// 関数 16.7%（314 行が未実行）で、タスク生成・プロファイル操作・IPC コマンド処理という
// 「外から副作用を起こせる」経路がほぼ未検証だった。
//
// ここで固定するのは次の 5 点:
//   1. **公開 API から承認フローを飛ばして破壊的操作へ到達できるか**を実測で固定する。
//      結論は「到達できる」＝ startNewTask / setConfiguration は呼び出し側が渡した
//      AgentSettings（alwaysAllowExecute などの自動承認フラグを含む）を無検証で
//      適用してからタスクを開始する。ここは characterization test として現状を明示し、
//      将来ガードを入れたら落ちるようにしておく
//   2. IPC で受け付ける全コマンドが、想定どおりのメソッドへ 1 対 1 で落ちること
//      （未知のコマンドは黙って捨てる）
//   3. 例外で IPC サーバが落ちないこと（ResumeTask / GetCommands / GetModes /
//      DeleteQueuedMessage の失敗は握ってログに落とす）
//   4. task のライフサイクルイベントが 1 つ残らず API イベントへ中継されること
//   5. プロファイル操作の事前条件（存在チェック）が必ず効くこと
//
// 外部ネットワーク・実ソケット・実ファイルには一切触らない。IpcServer / fs / ClineProvider は
// すべてモックする。

import { EventEmitter } from "events"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { AgentEventName, TaskCommandName, IpcMessageType, IpcOrigin } from "@openai-agent/types"

// --- モック定義 -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
	appendFile: vi.fn(async (..._args: unknown[]) => undefined),
	openClineInNewTab: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	getCommands: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
	ipcInstances: [] as Array<{
		socketPath: string
		handlers: Map<string, (...args: any[]) => unknown>
		listen: ReturnType<typeof vi.fn>
		send: ReturnType<typeof vi.fn>
		broadcast: ReturnType<typeof vi.fn>
	}>,
}))

vi.mock("vscode", () => ({
	commands: { executeCommand: mocks.executeCommand },
}))

// 実装は `import fs from "fs/promises"` の default import なので default も生やす。
vi.mock("fs/promises", () => {
	const api = { appendFile: mocks.appendFile }
	return { ...api, default: api }
})

vi.mock("@openai-agent/ipc", () => {
	// クラス名を import 名と衝突させない（ssr 変換対策）
	class MockIpcServer {
		socketPath: string
		handlers = new Map<string, (...args: any[]) => unknown>()
		listen = vi.fn()
		send = vi.fn()
		broadcast = vi.fn()

		constructor(socketPath: string, _log: unknown) {
			this.socketPath = socketPath
			mocks.ipcInstances.push(this as never)
		}

		on(event: string, handler: (...args: any[]) => unknown) {
			this.handlers.set(event, handler)
			return this
		}
	}
	return { IpcServer: MockIpcServer }
})

// 実 ClineProvider は依存が重い。api.ts は型としてしか使わないので空クラスで足りる。
vi.mock("../../core/webview/ClineProvider", () => ({ ClineProvider: class {} }))
vi.mock("../../activate/registerCommands", () => ({ openClineInNewTab: mocks.openClineInNewTab }))
vi.mock("../../services/command/commands", () => ({ getCommands: mocks.getCommands }))

import { API } from "../api"

// --- テスト用ヘルパ ---------------------------------------------------------

/** task の贋物。EventEmitter なので実装が張ったリスナをそのまま発火できる。 */
function makeTask(options: { taskId?: string; parentTaskId?: string } = {}) {
	const task = new EventEmitter() as EventEmitter & {
		taskId: string
		parentTaskId?: string
		submitUserMessage: ReturnType<typeof vi.fn>
		messageQueueService: { removeMessage: ReturnType<typeof vi.fn> }
	}
	task.taskId = options.taskId ?? "task-1"
	task.parentTaskId = options.parentTaskId
	task.submitUserMessage = vi.fn(async (..._args: unknown[]) => undefined)
	task.messageQueueService = { removeMessage: vi.fn(() => true) }
	return task
}

interface ProviderOptions {
	viewLaunched?: boolean
	currentTask?: ReturnType<typeof makeTask>
	values?: Record<string, unknown>
	profileEntries?: Array<{ name: string; id: string }>
	createTaskResult?: unknown
}

/** ClineProvider の贋物。provider.on を使うので EventEmitter を土台にする。 */
function makeProvider(options: ProviderOptions = {}) {
	const emitter = new EventEmitter()
	const entries = options.profileEntries ?? [{ name: "default", id: "id-default" }]

	const provider = Object.assign(emitter, {
		context: { extensionUri: { fsPath: "/ext" } },
		cwd: "/repo",
		viewLaunched: options.viewLaunched ?? true,
		postMessageToWebview: vi.fn(async (..._args: unknown[]) => undefined),
		postStateToWebview: vi.fn(async (..._args: unknown[]) => undefined),
		removeClineFromStack: vi.fn(async (..._args: unknown[]) => undefined),
		createTask: vi.fn(async (..._args: unknown[]) =>
			options.createTaskResult === undefined ? makeTask() : options.createTaskResult,
		),
		createTaskWithHistoryItem: vi.fn(async (..._args: unknown[]) => undefined),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id } })),
		getCurrentTaskStack: vi.fn(() => ["task-1"]),
		cancelTask: vi.fn(async () => undefined),
		getCurrentTask: vi.fn(() => options.currentTask),
		getModes: vi.fn(async () => [{ slug: "code", name: "Code" }]),
		getValues: vi.fn(() => options.values ?? { mode: "code", openAiApiKey: "sk-secret" }),
		contextProxy: { setValues: vi.fn(async (..._args: unknown[]) => undefined) },
		providerSettingsManager: { saveConfig: vi.fn(async (..._args: unknown[]) => undefined) },
		getProviderProfileEntries: vi.fn(() => entries),
		getProviderProfileEntry: vi.fn((name: string) => entries.find((e) => e.name === name)),
		upsertProviderProfile: vi.fn(async (..._args: unknown[]) => "id-new" as string | undefined),
		deleteProviderProfile: vi.fn(async (..._args: unknown[]) => undefined),
		activateProviderProfile: vi.fn(async (..._args: unknown[]) => undefined),
	})

	// リスナを大量に張るので上限警告を止める
	provider.setMaxListeners(100)

	return provider
}

function makeOutputChannel() {
	return { appendLine: vi.fn(), append: vi.fn(), dispose: vi.fn() }
}

interface ApiOptions extends ProviderOptions {
	socketPath?: string
	enableLogging?: boolean
}

function makeApi(options: ApiOptions = {}) {
	const outputChannel = makeOutputChannel()
	const provider = makeProvider(options)
	const api = new API(outputChannel as never, provider as never, options.socketPath, options.enableLogging ?? false)
	const ipc = mocks.ipcInstances[mocks.ipcInstances.length - 1]
	return { api, provider, outputChannel, ipc }
}

/** IPC の TaskCommand ハンドラを叩く。 */
async function sendCommand(
	ipc: (typeof mocks.ipcInstances)[number],
	command: Record<string, unknown>,
	clientId = "client-1",
) {
	const handler = ipc.handlers.get(IpcMessageType.TaskCommand)!
	return handler(clientId, command)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.ipcInstances.length = 0
	mocks.executeCommand.mockResolvedValue(undefined)
	mocks.appendFile.mockResolvedValue(undefined)
	mocks.getCommands.mockResolvedValue([])
})

afterEach(() => {
	vi.useRealTimers()
})

// --- 1. 承認フローとの関係（不変条件の実測） ---------------------------------

describe("API - 承認フローとの関係", () => {
	it("【現状の挙動】startNewTask は渡された設定を無検証でタスクへ適用する", async () => {
		// **公開 API から承認フローを飛ばして破壊的操作に到達できる。**
		// configuration はサニタイズも確認もされず createTask にそのまま渡り、
		// ClineProvider.createTask → applyCreateTaskConfiguration が
		// alwaysAllowExecute / autoApprovalEnabled / allowedCommands をそのまま反映する。
		// つまり API を叩ける者は、以後の全ツール実行を自動承認に切り替えられる。
		// ここは「直さずに固定する」characterization test。ガードを入れたら落ちる。
		const { api, provider } = makeApi()
		const dangerous = {
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			allowedCommands: ["*"],
		}

		await api.startNewTask({ configuration: dangerous as never, text: "rm -rf /" })

		expect(provider.createTask).toHaveBeenCalledTimes(1)
		const [text, images, parent, options, configuration] = provider.createTask.mock.calls[0]
		expect(text).toBe("rm -rf /")
		expect(images).toBeUndefined()
		expect(parent).toBeUndefined()
		expect(configuration).toBe(dangerous)
		// ミス上限も外される（自動運転前提の API）
		expect(options).toEqual({ consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER })
	})

	it("【現状の挙動】setConfiguration も自動承認フラグをそのまま保存する", async () => {
		const { api, provider } = makeApi()

		await api.setConfiguration({ alwaysAllowExecute: true, currentApiConfigName: "prof" } as never)

		expect(provider.contextProxy.setValues).toHaveBeenCalledWith({
			alwaysAllowExecute: true,
			currentApiConfigName: "prof",
		})
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("prof", {
			alwaysAllowExecute: true,
			currentApiConfigName: "prof",
		})
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("プロファイル名が無ければ default に保存する", async () => {
		const { api, provider } = makeApi()

		await api.setConfiguration({} as never)

		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", {})
	})
})

// --- 2. startNewTask ---------------------------------------------------------

describe("API - startNewTask", () => {
	it("サイドバーへフォーカスしてから新規チャットを開く", async () => {
		const { api, provider } = makeApi()

		const taskId = await api.startNewTask({ configuration: {} as never, text: "hi", images: ["img"] })

		expect(taskId).toBe("task-1")
		expect(mocks.executeCommand).toHaveBeenCalledWith(expect.stringContaining(".SidebarProvider.focus"))
		expect(provider.removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(provider.postMessageToWebview.mock.calls.map(([m]) => m)).toEqual([
			{ type: "action", action: "chatButtonClicked" },
			{ type: "invoke", invoke: "newChat", text: "hi", images: ["img"] },
		])
	})

	it("newTab 指定なら編集内容を戻してエディタを閉じ、新しいタブで開く", async () => {
		const tabProvider = makeProvider()
		mocks.openClineInNewTab.mockResolvedValue(tabProvider)
		const { api, provider, outputChannel } = makeApi()

		await api.startNewTask({ configuration: {} as never, newTab: true })

		expect(mocks.executeCommand.mock.calls.map(([c]) => c)).toEqual([
			"workbench.action.files.revert",
			"workbench.action.closeAllEditors",
		])
		expect(mocks.openClineInNewTab).toHaveBeenCalledWith({ context: provider.context, outputChannel })
		expect(tabProvider.createTask).toHaveBeenCalledTimes(1)
		expect(provider.createTask).not.toHaveBeenCalled()
		// 新しいタブの provider にもイベント中継が張られる
		expect(tabProvider.listenerCount(AgentEventName.TaskCreated)).toBe(1)
	})

	it("**タスクが作られなければ握りつぶさず投げる**", async () => {
		// ここを握ると「開始したつもりのタスクが存在しない」まま呼び出し側が進む。
		const { api } = makeApi({ createTaskResult: null })

		await expect(api.startNewTask({ configuration: {} as never })).rejects.toThrow(
			"Failed to create task due to policy restrictions",
		)
	})
})

// --- 3. resumeTask / isTaskInHistory -----------------------------------------

describe("API - resumeTask", () => {
	it("履歴から復元してチャット画面へ戻す", async () => {
		const { api, provider } = makeApi({ viewLaunched: true })

		await api.resumeTask("task-9")

		expect(provider.getTaskWithId).toHaveBeenCalledWith("task-9")
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "task-9" })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
	})

	it("webview が立ち上がらなくてもヘッドレスで続行する", async () => {
		vi.useFakeTimers()
		const { api, provider, outputChannel } = makeApi({ viewLaunched: false, enableLogging: true })

		const promise = api.resumeTask("task-9")
		// waitForWebviewLaunch の 5 秒タイムアウトを消化する
		await vi.advanceTimersByTimeAsync(6_000)
		await promise

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledTimes(1)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		const logged = outputChannel.appendLine.mock.calls.map(([line]) => String(line))
		expect(logged.some((line) => line.includes("webview did not launch within 5000ms"))).toBe(true)
		expect(logged.some((line) => line.includes("continuing in headless mode"))).toBe(true)
	})

	it("履歴にあるかどうかを例外なしで判定できる", async () => {
		const { api, provider } = makeApi()

		expect(await api.isTaskInHistory("task-1")).toBe(true)

		provider.getTaskWithId.mockRejectedValue(new Error("Task not found"))
		expect(await api.isTaskInHistory("missing")).toBe(false)
	})
})

// --- 4. 現在タスクへの操作 ---------------------------------------------------

describe("API - 現在タスクへの操作", () => {
	it("タスクスタックをそのまま返す", () => {
		const { api, provider } = makeApi()

		expect(api.getCurrentTaskStack()).toEqual(["task-1"])
		expect(provider.getCurrentTaskStack).toHaveBeenCalledTimes(1)
	})

	it("clearCurrentTask はスタックを空にして状態を送り直す", async () => {
		const { api, provider } = makeApi()

		await api.clearCurrentTask("bye")

		expect(provider.removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("cancelCurrentTask は provider へ委譲する", async () => {
		const { api, provider } = makeApi()

		await api.cancelCurrentTask()

		expect(provider.cancelTask).toHaveBeenCalledTimes(1)
	})

	it("webview があるときはメッセージを webview 経由で流す", async () => {
		const { api, provider } = makeApi({ viewLaunched: true })

		await api.sendMessage("hello", ["img"])

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: "hello",
			images: ["img"],
		})
	})

	it("ヘッドレスではタスクへ直接届ける", async () => {
		const task = makeTask()
		const { api, provider } = makeApi({ viewLaunched: false, currentTask: task })

		await api.sendMessage("hello", ["img"])

		expect(task.submitUserMessage).toHaveBeenCalledWith("hello", ["img"])
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("ヘッドレスで本文が無ければ空文字にして届ける", async () => {
		const task = makeTask()
		const { api } = makeApi({ viewLaunched: false, currentTask: task })

		await api.sendMessage(undefined, undefined)

		expect(task.submitUserMessage).toHaveBeenCalledWith("", undefined)
	})

	it("ヘッドレスでタスクが無ければ落とすだけ", async () => {
		const { api, outputChannel } = makeApi({ viewLaunched: false, enableLogging: true })

		await api.sendMessage("hello")

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[API#sendMessage] no current task in headless mode; message dropped",
		)
	})

	it("キュー済みメッセージの削除はタスクへ委譲する", () => {
		const task = makeTask()
		const { api } = makeApi({ currentTask: task })

		api.deleteQueuedMessage("m-1")

		expect(task.messageQueueService.removeMessage).toHaveBeenCalledWith("m-1")
	})

	it("タスクが無ければ削除は黙って無視する", () => {
		const { api, outputChannel } = makeApi({ enableLogging: true })

		expect(() => api.deleteQueuedMessage("m-1")).not.toThrow()
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[API#deleteQueuedMessage] no current task; ignoring delete for messageId m-1",
		)
	})

	it("ボタン押下は webview へ invoke として流す", async () => {
		const { api, provider } = makeApi()

		await api.pressPrimaryButton()
		await api.pressSecondaryButton()

		expect(provider.postMessageToWebview.mock.calls.map(([m]) => m)).toEqual([
			{ type: "invoke", invoke: "primaryButtonClick" },
			{ type: "invoke", invoke: "secondaryButtonClick" },
		])
	})

	it("isReady は webview の起動状態をそのまま返す", () => {
		expect(makeApi({ viewLaunched: true }).api.isReady()).toBe(true)
		expect(makeApi({ viewLaunched: false }).api.isReady()).toBe(false)
	})
})

// --- 5. IPC ------------------------------------------------------------------

describe("API - IPC", () => {
	it("socketPath が無ければ IPC サーバを立てない", () => {
		makeApi()

		expect(mocks.ipcInstances).toHaveLength(0)
	})

	it("socketPath があれば listen して TaskCommand を購読する", () => {
		const { ipc, outputChannel } = makeApi({ socketPath: "/tmp/sock", enableLogging: true })

		expect(ipc.socketPath).toBe("/tmp/sock")
		expect(ipc.listen).toHaveBeenCalledTimes(1)
		expect(ipc.handlers.has(IpcMessageType.TaskCommand)).toBe(true)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[API] ipc server started"))
	})

	it("StartNewTask コマンドがタスク生成へ落ちる", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, {
			commandName: TaskCommandName.StartNewTask,
			data: { configuration: { mode: "code" }, text: "go", images: undefined },
		})

		expect(provider.createTask).toHaveBeenCalledTimes(1)
	})

	it("CancelTask コマンドが中断へ落ちる", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.CancelTask })

		expect(provider.cancelTask).toHaveBeenCalledTimes(1)
	})

	it("CloseTask コマンドは保存してからウィンドウを閉じる", async () => {
		const { ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.CloseTask })

		expect(mocks.executeCommand.mock.calls.map(([c]) => c)).toEqual([
			"workbench.action.files.saveFiles",
			"workbench.action.closeWindow",
		])
	})

	it("ResumeTask コマンドが復元へ落ちる", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.ResumeTask, data: "task-3" })

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "task-3" })
	})

	it("**ResumeTask が失敗しても IPC サーバを落とさない**", async () => {
		const { provider, ipc, outputChannel } = makeApi({ socketPath: "/tmp/sock", enableLogging: true })
		provider.getTaskWithId.mockRejectedValue(new Error("Task not found"))

		await expect(
			sendCommand(ipc, { commandName: TaskCommandName.ResumeTask, data: "gone" }),
		).resolves.toBeUndefined()

		expect(outputChannel.appendLine).toHaveBeenCalledWith("[API] ResumeTask failed for taskId gone: Task not found")
	})

	it("Error 以外が投げられても文字列化してログに残す", async () => {
		const { provider, ipc, outputChannel } = makeApi({ socketPath: "/tmp/sock", enableLogging: true })
		provider.getTaskWithId.mockRejectedValue("plain failure")

		await sendCommand(ipc, { commandName: TaskCommandName.ResumeTask, data: "gone" })

		expect(outputChannel.appendLine).toHaveBeenCalledWith("[API] ResumeTask failed for taskId gone: plain failure")
	})

	it("SendMessage コマンドが送信へ落ちる", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.SendMessage, data: { text: "hi", images: ["i"] } })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: "hi",
			images: ["i"],
		})
	})

	it("GetCommands はスラッシュコマンド一覧を要約して返す", async () => {
		mocks.getCommands.mockResolvedValue([
			{
				name: "deploy",
				source: "project",
				filePath: "/repo/.agent/commands/deploy.md",
				description: "deploy it",
				argumentHint: "<env>",
				extra: "dropped",
			},
		])
		const { ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.GetCommands })

		expect(mocks.getCommands).toHaveBeenCalledWith("/repo")
		expect(ipc.send).toHaveBeenCalledWith("client-1", {
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			data: {
				eventName: AgentEventName.CommandsResponse,
				payload: [
					[
						{
							name: "deploy",
							source: "project",
							filePath: "/repo/.agent/commands/deploy.md",
							description: "deploy it",
							argumentHint: "<env>",
						},
					],
				],
			},
		})
	})

	it("GetCommands が失敗しても空配列を返して落ちない", async () => {
		mocks.getCommands.mockRejectedValue(new Error("fs error"))
		const { ipc } = makeApi({ socketPath: "/tmp/sock" })

		await expect(sendCommand(ipc, { commandName: TaskCommandName.GetCommands })).resolves.toBeUndefined()

		expect(ipc.send.mock.calls[0][1].data.payload).toEqual([[]])
	})

	it("GetModes はモード一覧を返す", async () => {
		const { ipc } = makeApi({ socketPath: "/tmp/sock" })

		await sendCommand(ipc, { commandName: TaskCommandName.GetModes })

		expect(ipc.send.mock.calls[0][1].data).toEqual({
			eventName: AgentEventName.ModesResponse,
			payload: [[{ slug: "code", name: "Code" }]],
		})
	})

	it("GetModes が失敗しても空配列を返して落ちない", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })
		provider.getModes.mockRejectedValue(new Error("boom"))

		await sendCommand(ipc, { commandName: TaskCommandName.GetModes })

		expect(ipc.send.mock.calls[0][1].data.payload).toEqual([[]])
	})

	it("DeleteQueuedMessage コマンドが削除へ落ちる", async () => {
		const task = makeTask()
		const { ipc } = makeApi({ socketPath: "/tmp/sock", currentTask: task })

		await sendCommand(ipc, { commandName: TaskCommandName.DeleteQueuedMessage, data: "m-7" })

		expect(task.messageQueueService.removeMessage).toHaveBeenCalledWith("m-7")
	})

	it("**DeleteQueuedMessage が失敗しても IPC サーバを落とさない**", async () => {
		const task = makeTask()
		task.messageQueueService.removeMessage = vi.fn(() => {
			throw new Error("queue broken")
		})
		const { ipc, outputChannel } = makeApi({ socketPath: "/tmp/sock", currentTask: task, enableLogging: true })

		await expect(
			sendCommand(ipc, { commandName: TaskCommandName.DeleteQueuedMessage, data: "m-7" }),
		).resolves.toBeUndefined()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[API] DeleteQueuedMessage failed for messageId m-7: queue broken",
		)
	})

	it("Error 以外が投げられても文字列化してログに残す", async () => {
		const task = makeTask()
		task.messageQueueService.removeMessage = vi.fn(() => {
			throw "queue exploded"
		})
		const { ipc, outputChannel } = makeApi({ socketPath: "/tmp/sock", currentTask: task, enableLogging: true })

		await sendCommand(ipc, { commandName: TaskCommandName.DeleteQueuedMessage, data: "m-7" })

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[API] DeleteQueuedMessage failed for messageId m-7: queue exploded",
		)
	})

	it("未知のコマンドは何もせず黙って捨てる", async () => {
		const { provider, ipc } = makeApi({ socketPath: "/tmp/sock" })

		await expect(sendCommand(ipc, { commandName: TaskCommandName.GetModels })).resolves.toBeUndefined()

		expect(ipc.send).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.cancelTask).not.toHaveBeenCalled()
	})

	it("emit は IPC にもブロードキャストする", () => {
		const { api, ipc } = makeApi({ socketPath: "/tmp/sock" })

		api.emit(AgentEventName.TaskAborted, "task-1")

		expect(ipc.broadcast).toHaveBeenCalledWith({
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			data: { eventName: AgentEventName.TaskAborted, payload: ["task-1"] },
		})
	})

	it("IPC が無くても emit は通常どおり動く", () => {
		const { api } = makeApi()
		const listener = vi.fn()
		api.on(AgentEventName.TaskAborted, listener)

		expect(api.emit(AgentEventName.TaskAborted, "task-1")).toBe(true)
		expect(listener).toHaveBeenCalledWith("task-1")
	})
})

// --- 6. イベント中継 ---------------------------------------------------------

describe("API - task イベントの中継", () => {
	/** provider に task を作らせ、API 側で観測されたイベントを集める。 */
	function withTask(options: { parentTaskId?: string; enableLogging?: boolean } = {}) {
		const { api, provider, outputChannel } = makeApi({ enableLogging: options.enableLogging })
		const seen: Array<{ name: string; args: unknown[] }> = []
		for (const name of Object.values(AgentEventName)) {
			api.on(name as never, ((...args: unknown[]) => seen.push({ name, args })) as never)
		}

		const task = makeTask({ parentTaskId: options.parentTaskId })
		provider.emit(AgentEventName.TaskCreated, task)

		return { api, task, seen, outputChannel }
	}

	it("タスク生成を中継する", () => {
		const { seen } = withTask()

		expect(seen).toEqual([{ name: AgentEventName.TaskCreated, args: ["task-1"] }])
	})

	const simpleEvents = [
		AgentEventName.TaskAborted,
		AgentEventName.TaskFocused,
		AgentEventName.TaskUnfocused,
		AgentEventName.TaskActive,
		AgentEventName.TaskInteractive,
		AgentEventName.TaskResumable,
		AgentEventName.TaskIdle,
		AgentEventName.TaskPaused,
		AgentEventName.TaskUnpaused,
		AgentEventName.TaskAskResponded,
	]

	for (const event of simpleEvents) {
		it(`${event} を taskId 付きで中継する`, () => {
			const { task, seen } = withTask()
			seen.length = 0

			task.emit(event)

			expect(seen).toEqual([{ name: event, args: ["task-1"] }])
		})
	}

	it("開始イベントはログにも残す", async () => {
		const { task, outputChannel } = withTask({ enableLogging: true })

		task.emit(AgentEventName.TaskStarted)
		await vi.waitFor(() => expect(mocks.appendFile).toHaveBeenCalled())

		expect(String(mocks.appendFile.mock.calls[0][1])).toContain("taskStarted -> task-1")
		expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("taskStarted"))
	})

	it("完了イベントはサブタスクかどうかを添えて中継する", async () => {
		const { task, seen } = withTask()
		seen.length = 0

		task.emit(AgentEventName.TaskCompleted, "task-1", { in: 1 }, { edit: 2 })
		await vi.waitFor(() => expect(seen).toHaveLength(1))

		expect(seen[0]).toEqual({
			name: AgentEventName.TaskCompleted,
			args: ["task-1", { in: 1 }, { edit: 2 }, { isSubtask: false }],
		})
	})

	it("親タスクがあれば isSubtask が立つ", async () => {
		const { task, seen } = withTask({ parentTaskId: "parent-1" })
		seen.length = 0

		task.emit(AgentEventName.TaskCompleted, "task-1", {}, {})
		await vi.waitFor(() => expect(seen).toHaveLength(1))

		expect((seen[0].args[3] as { isSubtask: boolean }).isSubtask).toBe(true)
	})

	it("サブタスク生成・委譲系を中継する", () => {
		const { task, seen } = withTask()
		seen.length = 0

		task.emit(AgentEventName.TaskSpawned, "child-1")
		task.emit(AgentEventName.TaskDelegated, "child-1")
		task.emit(AgentEventName.TaskDelegationCompleted, "child-1", "summary")
		task.emit(AgentEventName.TaskDelegationResumed, "child-1")

		expect(seen).toEqual([
			{ name: AgentEventName.TaskSpawned, args: ["task-1", "child-1"] },
			{ name: AgentEventName.TaskDelegated, args: ["task-1", "child-1"] },
			{ name: AgentEventName.TaskDelegationCompleted, args: ["task-1", "child-1", "summary"] },
			{ name: AgentEventName.TaskDelegationResumed, args: ["task-1", "child-1"] },
		])
	})

	it("確定メッセージは中継とログの両方に流す", async () => {
		const { task, seen } = withTask({ enableLogging: true })
		seen.length = 0

		task.emit(AgentEventName.Message, { action: "created", message: { ts: 1, text: "hi", partial: false } })
		await vi.waitFor(() => expect(mocks.appendFile).toHaveBeenCalled())

		expect(seen[0].args[0]).toMatchObject({ taskId: "task-1", action: "created" })
		expect(String(mocks.appendFile.mock.calls[0][1])).toContain('"text": "hi"')
	})

	it("ストリーミング中のメッセージはログに残さない", async () => {
		const { task, seen } = withTask({ enableLogging: true })
		seen.length = 0

		task.emit(AgentEventName.Message, { action: "updated", message: { ts: 1, text: "h", partial: true } })
		await vi.waitFor(() => expect(seen).toHaveLength(1))

		expect(mocks.appendFile).not.toHaveBeenCalled()
	})

	it("モード切替・キュー更新・失敗・トークン使用量を中継する", () => {
		const { task, seen } = withTask()
		seen.length = 0

		task.emit(AgentEventName.TaskModeSwitched, "task-1", "architect")
		task.emit(AgentEventName.QueuedMessagesUpdated, "task-1", [{ id: "m-1" }])
		task.emit(AgentEventName.TaskToolFailed, "task-1", "execute_command", "boom")
		task.emit(AgentEventName.TaskTokenUsageUpdated, "ignored", { in: 3 }, { edit: 1 })

		expect(seen).toEqual([
			{ name: AgentEventName.TaskModeSwitched, args: ["task-1", "architect"] },
			{ name: AgentEventName.QueuedMessagesUpdated, args: ["task-1", [{ id: "m-1" }]] },
			{ name: AgentEventName.TaskToolFailed, args: ["task-1", "execute_command", "boom"] },
			// 第 1 引数は無視され、常に task.taskId が使われる
			{ name: AgentEventName.TaskTokenUsageUpdated, args: ["task-1", { in: 3 }, { edit: 1 }] },
		])
	})
})

// --- 7. ログ -----------------------------------------------------------------

describe("API - ログ", () => {
	it("ログ無効ならファイルにも出力チャネルにも書かない", async () => {
		const { api, provider, outputChannel } = makeApi({ enableLogging: false })
		const task = makeTask()
		provider.emit(AgentEventName.TaskCreated, task)

		task.emit(AgentEventName.TaskStarted)
		await api.sendMessage("hi")
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(outputChannel.appendLine).not.toHaveBeenCalled()
		expect(mocks.appendFile).not.toHaveBeenCalled()
	})

	it("ログ有効なら出力チャネルと console の両方へ流す", () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const { api, outputChannel } = makeApi({ enableLogging: true })

		api.deleteQueuedMessage("m-1")

		expect(outputChannel.appendLine).toHaveBeenCalledTimes(1)
		expect(consoleLog).toHaveBeenCalledTimes(1)
		consoleLog.mockRestore()
	})

	it("ファイル書き込みに失敗したら以後のファイルログを諦める", async () => {
		mocks.appendFile.mockRejectedValue(new Error("EACCES"))
		const { provider } = makeApi({ enableLogging: true })
		const task = makeTask()
		provider.emit(AgentEventName.TaskCreated, task)

		task.emit(AgentEventName.TaskStarted)
		await vi.waitFor(() => expect(mocks.appendFile).toHaveBeenCalledTimes(1))

		// 2 回目以降は logfile が undefined になっているので呼ばれない
		task.emit(AgentEventName.TaskStarted)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(mocks.appendFile).toHaveBeenCalledTimes(1)
	})

	describe("outputChannelLog の値の扱い", () => {
		/** log() を直接叩いて 1 行ずつ検証する。 */
		function logLines(...args: unknown[]) {
			const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
			const { api, outputChannel } = makeApi({ enableLogging: true })
			;(api as unknown as { log: (...a: unknown[]) => void }).log(...args)
			consoleLog.mockRestore()
			return outputChannel.appendLine.mock.calls.map(([line]) => line as string)
		}

		it("null / undefined / 文字列はそのまま", () => {
			expect(logLines(null, undefined, "plain")).toEqual(["null", "undefined", "plain"])
		})

		it("Error はメッセージとスタックを並べる", () => {
			const error = new Error("boom")
			error.stack = "STACK"

			expect(logLines(error)).toEqual(["Error: boom\nSTACK"])
		})

		it("スタックが無い Error でも落ちない", () => {
			const error = new Error("boom")
			error.stack = undefined

			expect(logLines(error)).toEqual(["Error: boom\n"])
		})

		it("オブジェクトは JSON 化し、bigint / 関数 / symbol は読める形に置き換える", () => {
			const named = function namedFn() {}
			const lines = logLines({
				big: BigInt(7),
				fn: named,
				anon: (() => () => {})(),
				sym: Symbol("s"),
				plain: 1,
			})

			expect(lines[0]).toContain('"big": "BigInt(7)"')
			expect(lines[0]).toContain('"fn": "Function: namedFn"')
			expect(lines[0]).toContain('"sym": "Symbol(s)"')
			expect(lines[0]).toContain('"plain": 1')
		})

		it("無名関数は anonymous として出す", () => {
			const lines = logLines({ fn: Object.defineProperty(() => {}, "name", { value: "" }) })

			expect(lines[0]).toContain('"fn": "Function: anonymous"')
		})

		it("循環参照はシリアライズ不能として落とす", () => {
			const circular: Record<string, unknown> = {}
			circular.self = circular

			expect(logLines(circular)).toEqual(["[Non-serializable object: [object Object]]"])
		})
	})
})

// --- 8. 設定とプロファイル ---------------------------------------------------

describe("API - 設定とプロファイル", () => {
	it("**getConfiguration は秘匿キーを落として返す**", async () => {
		// API 越しに API キーが漏れないことが、この関数の存在理由。
		const { api } = makeApi({ values: { mode: "code", openAiApiKey: "sk-secret", codeIndexQdrantApiKey: "q" } })

		expect(api.getConfiguration()).toEqual({ mode: "code" })
	})

	it("プロファイル一覧は名前だけを返す", () => {
		const { api } = makeApi({
			profileEntries: [
				{ name: "a", id: "1" },
				{ name: "b", id: "2" },
			],
		})

		expect(api.getProfiles()).toEqual(["a", "b"])
	})

	it("プロファイル 1 件の取得", () => {
		const { api } = makeApi({ profileEntries: [{ name: "a", id: "1" }] })

		expect(api.getProfileEntry("a")).toEqual({ name: "a", id: "1" })
		expect(api.getProfileEntry("nope")).toBeUndefined()
	})

	it("createProfile は既存名を拒否する", async () => {
		const { api, provider } = makeApi({ profileEntries: [{ name: "dup", id: "1" }] })

		await expect(api.createProfile("dup")).rejects.toThrow('Profile with name "dup" already exists')
		expect(provider.upsertProviderProfile).not.toHaveBeenCalled()
	})

	it("createProfile は中身省略時に空オブジェクトで作る", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		expect(await api.createProfile("new")).toBe("id-new")
		expect(provider.upsertProviderProfile).toHaveBeenCalledWith("new", {}, true)
	})

	it("createProfile は activate 指定を尊重する", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		await api.createProfile("new", { apiProvider: "openai" } as never, false)

		expect(provider.upsertProviderProfile).toHaveBeenCalledWith("new", { apiProvider: "openai" }, false)
	})

	it("createProfile は ID が返らなければ投げる", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })
		provider.upsertProviderProfile.mockResolvedValue(undefined)

		await expect(api.createProfile("new")).rejects.toThrow('Failed to create profile with name "new"')
	})

	it("updateProfile は存在しない名前を拒否する", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		await expect(api.updateProfile("nope", {} as never)).rejects.toThrow('Profile with name "nope" does not exist')
		expect(provider.upsertProviderProfile).not.toHaveBeenCalled()
	})

	it("updateProfile は既存プロファイルを書き換える", async () => {
		const { api, provider } = makeApi({ profileEntries: [{ name: "a", id: "1" }] })

		expect(await api.updateProfile("a", { apiProvider: "openai" } as never, false)).toBe("id-new")
		expect(provider.upsertProviderProfile).toHaveBeenCalledWith("a", { apiProvider: "openai" }, false)
	})

	it("updateProfile は ID が返らなければ投げる", async () => {
		const { api, provider } = makeApi({ profileEntries: [{ name: "a", id: "1" }] })
		provider.upsertProviderProfile.mockResolvedValue(undefined)

		await expect(api.updateProfile("a", {} as never)).rejects.toThrow('Failed to update profile with name "a"')
	})

	it("upsertProfile は存在チェックなしで書き込む", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		expect(await api.upsertProfile("brand-new", {} as never)).toBe("id-new")
		expect(provider.upsertProviderProfile).toHaveBeenCalledWith("brand-new", {}, true)
	})

	it("upsertProfile は ID が返らなければ投げる", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })
		provider.upsertProviderProfile.mockResolvedValue(undefined)

		await expect(api.upsertProfile("x", {} as never)).rejects.toThrow('Failed to upsert profile with name "x"')
	})

	it("**deleteProfile は存在しない名前では削除しに行かない**", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		await expect(api.deleteProfile("nope")).rejects.toThrow('Profile with name "nope" does not exist')
		expect(provider.deleteProviderProfile).not.toHaveBeenCalled()
	})

	it("deleteProfile はエントリごと渡して削除する", async () => {
		const { api, provider } = makeApi({ profileEntries: [{ name: "a", id: "1" }] })

		await api.deleteProfile("a")

		expect(provider.deleteProviderProfile).toHaveBeenCalledWith({ name: "a", id: "1" })
	})

	it("getActiveProfile は設定から現在のプロファイル名を読む", () => {
		const { api } = makeApi({ values: { currentApiConfigName: "active-one" } })

		expect(api.getActiveProfile()).toBe("active-one")
	})

	it("setActiveProfile は存在しない名前を拒否する", async () => {
		const { api, provider } = makeApi({ profileEntries: [] })

		await expect(api.setActiveProfile("nope")).rejects.toThrow('Profile with name "nope" does not exist')
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("setActiveProfile は切り替えたあとの名前を返す", async () => {
		const { api, provider } = makeApi({
			profileEntries: [{ name: "a", id: "1" }],
			values: { currentApiConfigName: "a" },
		})

		expect(await api.setActiveProfile("a")).toBe("a")
		expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "a" })
	})
})
