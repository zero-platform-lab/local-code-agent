// npx vitest run core/webview/__tests__/commandMessageHandlers.spec.ts
//
// commandMessageHandlers はスラッシュコマンドの「ファイルを消す / 作る」と
// 「許可・拒否コマンドをグローバル設定へ書く」という、取り返しのつかない副作用を
// 2 種類持っている。行数を稼ぐのではなく、以下を不変条件として固定する。
//
//   1. fs.unlink / fs.writeFile / fs.mkdir に渡った「全パス」が想定ディレクトリ配下に収まること。
//      コマンド名にセパレータや ".." が混ざってもパスが抜けないこと。
//   2. deniedCommands の更新で既存エントリが黙って消えないこと。
//   3. グローバル設定への書き込みが、意図したキーにだけ・意図した回数だけ起きること。
//
// 1 は createCommand 側（slugifyCommandName を通る経路）だけでなく deleteCommand 側でも
// 守る。getCommand（services/command/commands.ts の tryLoadCommand）は
// `path.join(dir, `${name}.md`)` を組むだけでサニタイズしないので、
// パスを組ませる前にハンドラ側で名前を検査する。

import * as path from "path"
import * as os from "os"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { SkillMetadata, WebviewMessage } from "@openai-agent/types"

import { defaultModeSlug } from "../../../shared/modes"
import { Package } from "../../../shared/package"

import { commandMessageHandlers } from "../commandMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const {
	unlinkMock,
	mkdirMock,
	writeFileMock,
	accessMock,
	getCommandsMock,
	getCommandMock,
	openFileMock,
	showErrorMessageMock,
	getConfigurationMock,
	configUpdateMock,
} = vi.hoisted(() => {
	const configUpdate = vi.fn(async (..._args: unknown[]) => undefined)
	return {
		unlinkMock: vi.fn(async (..._args: unknown[]) => undefined),
		mkdirMock: vi.fn(async (..._args: unknown[]) => undefined),
		writeFileMock: vi.fn(async (..._args: unknown[]) => undefined),
		// 既定は「存在しない」。beforeEach で throw する実装に差し替える（fileExists の catch 側）。
		accessMock: vi.fn(async (..._args: unknown[]): Promise<undefined> => undefined),
		getCommandsMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
		getCommandMock: vi.fn(async (..._args: unknown[]) => undefined as unknown),
		openFileMock: vi.fn(),
		showErrorMessageMock: vi.fn(),
		configUpdateMock: configUpdate,
		getConfigurationMock: vi.fn((..._args: unknown[]) => ({ update: configUpdate })),
	}
})

// 実装は `import * as fs from "fs/promises"` の名前空間 import。default も生やしておく。
vi.mock("fs/promises", () => {
	const api = { unlink: unlinkMock, mkdir: mkdirMock, writeFile: writeFileMock, access: accessMock }
	return { ...api, default: api }
})

vi.mock("vscode", () => ({
	window: { showErrorMessage: showErrorMessageMock },
	// workspaceFolders はテストごとに差し替えるので普通のプロパティにしておく。
	workspace: { workspaceFolders: [] as unknown[] | undefined, getConfiguration: getConfigurationMock },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}))

vi.mock("../../../services/command/commands", () => ({
	getCommands: getCommandsMock,
	getCommand: getCommandMock,
}))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: openFileMock }))

// t はキーをそのまま返す。「どのメッセージが出たか」をキーで検査できる。
vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

import * as vscode from "vscode"

// ---------------------------------------------------------------------------
// 定数 / ヘルパ
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/workspace/project"
const PROJECT_COMMANDS_DIR = path.join(WORKSPACE_DIR, ".agent", "commands")
const GLOBAL_COMMANDS_DIR = path.join(os.homedir(), ".agent", "commands")

/** fs.unlink に渡った第 1 引数を呼ばれた順に全件返す。 */
const unlinkPaths = (): string[] => unlinkMock.mock.calls.map((call) => call[0] as string)

/** fs.writeFile に渡った第 1 引数を呼ばれた順に全件返す。 */
const writeFilePaths = (): string[] => writeFileMock.mock.calls.map((call) => call[0] as string)

/** fs.mkdir に渡った第 1 引数を呼ばれた順に全件返す。 */
const mkdirPaths = (): string[] => mkdirMock.mock.calls.map((call) => call[0] as string)

/** fs.access に渡った第 1 引数を呼ばれた順に全件返す。 */
const accessPaths = (): string[] => accessMock.mock.calls.map((call) => call[0] as string)

/**
 * 渡されたパス群が全て `<dir>/<1 セグメント>` の形であることを検査する。
 *
 * TaskDeletionController.spec.ts の expectAllRmPathsInsideTasksDir と同じ形。
 * 「1 ファイルのつもりが上位ディレクトリを触った」を、期待値の一致とは別枠で必ず潰す。
 */
function expectAllPathsDirectlyUnder(paths: string[], dir: string): void {
	const resolvedDir = path.resolve(dir)
	for (const p of paths) {
		expect(path.isAbsolute(p)).toBe(true)
		const resolved = path.resolve(p)
		expect(path.dirname(resolved)).toBe(resolvedDir)
		const segment = path.basename(resolved)
		expect(segment).not.toBe("")
		expect(segment).not.toBe(".")
		expect(segment).not.toBe("..")
		// 正規化しても同じ位置に戻る＝途中で上位へ抜けていない。
		expect(resolved).toBe(path.join(resolvedDir, segment))
	}
}

interface FakeTask {
	cwd?: string
	modeState?: { getMode: () => Promise<string> }
}

interface ProviderOptions {
	cwd?: string
	task?: FakeTask
	/** getState の実装。throw させたい場合もここで差し替える。 */
	getStateImpl?: () => Promise<Record<string, unknown>>
	skillsManager?: { getSkillsForMode: (mode: string) => SkillMetadata[] }
	/** contextProxy に既に保存されている値（既存の許可 / 拒否リストなど）。 */
	storedValues?: Record<string, unknown>
}

function makeProvider(options: ProviderOptions = {}) {
	const log = vi.fn()
	const postMessageToWebview = vi.fn(async (..._args: unknown[]) => undefined)
	// setValue はスパイであると同時に「保存済みの値」を持つ。
	// 「壊れたメッセージで既存リストが消えない」は、呼ばれた回数ではなく
	// 保存されている中身で確かめたいため。
	const stored = new Map<string, unknown>(Object.entries(options.storedValues ?? {}))
	const setValue = vi.fn(async (...args: unknown[]) => {
		stored.set(args[0] as string, args[1])
		return undefined
	})
	const getState = vi.fn(options.getStateImpl ?? (async () => ({}) as Record<string, unknown>))
	const getCurrentTask = vi.fn(() => options.task)
	const getSkillsManager = vi.fn(() => options.skillsManager)

	// 型ドリフトを避けるため、実際に触るメンバだけを持つ最小の fake にしている。
	const provider = {
		cwd: options.cwd ?? WORKSPACE_DIR,
		contextProxy: { setValue },
		log,
		postMessageToWebview,
		getState,
		getCurrentTask,
		getSkillsManager,
	} as unknown as WebviewMessageHost

	return {
		provider,
		log,
		postMessageToWebview,
		setValue,
		getState,
		getCurrentTask,
		getSkillsManager,
		/** contextProxy に保存されている値。 */
		stored,
	}
}

const msg = (message: Record<string, unknown>): WebviewMessage => message as unknown as WebviewMessage

/** テスト対象のハンドラを型安全に取り出す（Partial なので undefined を潰す）。 */
function handler(type: string) {
	const fn = (commandMessageHandlers as Record<string, unknown>)[type]
	if (typeof fn !== "function") {
		throw new Error(`handler not registered: ${type}`)
	}
	return fn as (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>
}

/** fs.access の応答を「存在するパスの集合」で決める。 */
function setExistingFiles(paths: string[]): void {
	const existing = new Set(paths.map((p) => path.resolve(p)))
	accessMock.mockImplementation(async (...args: unknown[]) => {
		if (existing.has(path.resolve(args[0] as string))) {
			return undefined
		}
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})
}

/**
 * getCommand を「services/command/commands の素朴な再現」に差し替える。
 *
 * 本物の tryLoadCommand は `path.join(dir, `${name}.md`)` を組み立てるだけで、
 * name のサニタイズを一切しない。そのガード不在ごと再現しないと
 * 「ハンドラ側が守っているのか」を見分けられないので、意図的にそのまま写す。
 */
function useNaiveGetCommand(existingCommandFiles: string[]): void {
	const existing = new Set(existingCommandFiles.map((p) => path.resolve(p)))
	getCommandMock.mockImplementation(async (...args: unknown[]) => {
		const cwd = args[0] as string
		const name = args[1] as string
		const candidates: { dir: string; source: "project" | "global" }[] = [
			{ dir: path.join(cwd, ".agent", "commands"), source: "project" },
			{ dir: GLOBAL_COMMANDS_DIR, source: "global" },
		]
		for (const { dir, source } of candidates) {
			const filePath = path.join(dir, `${name}.md`)
			if (existing.has(path.resolve(filePath))) {
				return { name, source, filePath, content: "" }
			}
		}
		return undefined
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	unlinkMock.mockImplementation(async () => undefined)
	mkdirMock.mockImplementation(async () => undefined)
	writeFileMock.mockImplementation(async () => undefined)
	accessMock.mockImplementation(async () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})
	getCommandsMock.mockImplementation(async () => [])
	getCommandMock.mockImplementation(async () => undefined)
	configUpdateMock.mockImplementation(async () => undefined)
	getConfigurationMock.mockImplementation(() => ({ update: configUpdateMock }))
	// 既定はワークスペースあり。project コマンドの分岐で差し替える。
	;(vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [{ uri: { fsPath: WORKSPACE_DIR } }]
})

// ---------------------------------------------------------------------------

describe("commandMessageHandlers", () => {
	describe("allowedCommands / deniedCommands（不変条件 2・3）", () => {
		it("allowedCommands は state と Global 設定の両方へ同じ配列を書く", async () => {
			const h = makeProvider()

			await handler("allowedCommands")(h.provider, msg({ type: "allowedCommands", commands: ["ls", "git log"] }))

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["ls", "git log"])
			expect(getConfigurationMock).toHaveBeenCalledExactlyOnceWith(Package.name)
			expect(configUpdateMock).toHaveBeenCalledExactlyOnceWith(
				"allowedCommands",
				["ls", "git log"],
				vscode.ConfigurationTarget.Global,
			)
		})

		it("【不変条件】deniedCommands の更新で既存エントリが 1 件も落ちない（順序も保つ）", async () => {
			const h = makeProvider()
			// denylist は安全側の設定。1 件でも落ちると「拒否したはずのコマンドが通る」になる。
			const denied = ["rm -rf /", "sudo *", "curl * | sh", "git push --force", "  chmod 777 /  "]

			await handler("deniedCommands")(h.provider, msg({ type: "deniedCommands", commands: [...denied] }))

			const writtenToState = h.setValue.mock.calls[0]![1] as string[]
			const writtenToConfig = configUpdateMock.mock.calls[0]![1] as string[]
			// 完全一致（＝欠落も並び替えも trim も無い）。
			expect(writtenToState).toEqual(denied)
			expect(writtenToConfig).toEqual(denied)
			for (const entry of denied) {
				expect(writtenToState).toContain(entry)
				expect(writtenToConfig).toContain(entry)
			}
		})

		it("【不変条件】書き込みは意図したキーにだけ起きる（allowed 側で denied を触らない・逆も同様）", async () => {
			const h = makeProvider()

			await handler("allowedCommands")(h.provider, msg({ type: "allowedCommands", commands: ["ls"] }))

			expect(h.setValue.mock.calls.map((call) => call[0])).toEqual(["allowedCommands"])
			expect(configUpdateMock.mock.calls.map((call) => call[0])).toEqual(["allowedCommands"])

			vi.clearAllMocks()
			configUpdateMock.mockImplementation(async () => undefined)
			getConfigurationMock.mockImplementation(() => ({ update: configUpdateMock }))

			await handler("deniedCommands")(h.provider, msg({ type: "deniedCommands", commands: ["rm -rf /"] }))

			expect(h.setValue.mock.calls.map((call) => call[0])).toEqual(["deniedCommands"])
			expect(configUpdateMock.mock.calls.map((call) => call[0])).toEqual(["deniedCommands"])
			// 設定書き込みは Global スコープ 1 回だけ（Workspace 等へ二重書きしない）。
			expect(configUpdateMock.mock.calls.map((call) => call[2])).toEqual([vscode.ConfigurationTarget.Global])
		})

		it("文字列でない値と空白だけの値は落とし、それ以外は残す", async () => {
			const h = makeProvider()

			await handler("allowedCommands")(
				h.provider,
				msg({
					type: "allowedCommands",
					// webview / CLI から壊れた配列が来る想定。
					commands: ["ls", "", "   ", 42, null, undefined, { name: "x" }, ["nested"], "git status"],
				}),
			)

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["ls", "git status"])
		})

		// 【不変条件 2】壊れた 1 メッセージで denylist を空にしない。
		//
		// 「空にする」と「値が壊れている」を同一視すると、配列でない commands が 1 通届いた
		// だけで拒否コマンドが全消えし、以後は拒否したはずのコマンドが素通りする。
		// しかも通知が無いので誰も気づけない。配列でなければ state も Global 設定も触らない。
		it.each([
			["commands 未指定", undefined],
			["配列でない（文字列）", "rm -rf /"],
			["配列でない（オブジェクト）", { 0: "ls" }],
			["null", null],
		])("【不変条件】deniedCommands が %s のメッセージでは denylist を書き換えない", async (_label, commands) => {
			const existing = ["rm -rf /", "sudo *"]
			const h = makeProvider({ storedValues: { deniedCommands: [...existing] } })

			await handler("deniedCommands")(h.provider, msg({ type: "deniedCommands", commands: commands as unknown }))

			// 保存済みの拒否リストがそのまま残る。
			expect(h.stored.get("deniedCommands")).toEqual(existing)
			expect(h.setValue).not.toHaveBeenCalled()
			// VSCode 設定側にも触らない（getConfiguration すら呼ばない）。
			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(configUpdateMock).not.toHaveBeenCalled()
			// 黙って捨てず、ログには残す。
			expect(h.log).toHaveBeenCalledExactlyOnceWith(
				"deniedCommands: ignoring a message whose `commands` is not an array",
			)
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it.each([
			["配列でない（文字列）", "ls"],
			["commands 未指定", undefined],
		])("【不変条件】allowedCommands でも %s なら許可リストを書き換えない", async (_label, commands) => {
			const existing = ["ls", "git status"]
			const h = makeProvider({ storedValues: { allowedCommands: [...existing] } })

			await handler("allowedCommands")(
				h.provider,
				msg({ type: "allowedCommands", commands: commands as unknown }),
			)

			expect(h.stored.get("allowedCommands")).toEqual(existing)
			expect(h.setValue).not.toHaveBeenCalled()
			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(configUpdateMock).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledExactlyOnceWith(
				"allowedCommands: ignoring a message whose `commands` is not an array",
			)
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 空配列は「壊れている」ではなく「明示的に空にする」操作なので通す。
		it.each([
			["allowedCommands", "allowedCommands"],
			["deniedCommands", "deniedCommands"],
		])("%s は空配列なら意図的なクリアとして保存する", async (_label, type) => {
			const h = makeProvider({ storedValues: { [type]: ["old"] } })

			await handler(type)(h.provider, msg({ type, commands: [] }))

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith(type, [])
			expect(h.stored.get(type)).toEqual([])
			expect(configUpdateMock).toHaveBeenCalledExactlyOnceWith(type, [], vscode.ConfigurationTarget.Global)
			expect(h.log).not.toHaveBeenCalled()
		})
	})

	describe("requestCommands", () => {
		it("ファイルコマンドを webview 向けの形へ写す", async () => {
			const h = makeProvider()
			getCommandsMock.mockResolvedValue([
				{
					name: "review",
					source: "project",
					filePath: path.join(PROJECT_COMMANDS_DIR, "review.md"),
					description: "レビュー",
					argumentHint: "<pr>",
					content: "本文",
					mode: "code",
				},
			])

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			// content / mode は webview へ送らない（一覧に不要）。
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "commands",
				commands: [
					{
						name: "review",
						source: "project",
						filePath: path.join(PROJECT_COMMANDS_DIR, "review.md"),
						description: "レビュー",
						argumentHint: "<pr>",
					},
				],
			})
			expect(getCommandsMock).toHaveBeenCalledExactlyOnceWith(WORKSPACE_DIR)
		})

		it("実行中タスクがあればその cwd でコマンドを探す", async () => {
			const h = makeProvider({ task: { cwd: "/task/cwd" } })

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(getCommandsMock).toHaveBeenCalledExactlyOnceWith("/task/cwd")
		})

		it("実行中タスクの cwd が空文字なら provider の cwd に落ちる", async () => {
			const h = makeProvider({ task: { cwd: "" }, cwd: "/fallback" })

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(getCommandsMock).toHaveBeenCalledExactlyOnceWith("/fallback")
		})

		it("SkillsManager が無ければコマンドだけを返す（モード解決もしない）", async () => {
			const h = makeProvider()
			getCommandsMock.mockResolvedValue([{ name: "a", source: "global", filePath: "/a.md" }])

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(h.getState).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "commands",
				commands: [
					{
						name: "a",
						source: "global",
						filePath: "/a.md",
						description: undefined,
						argumentHint: undefined,
					},
				],
			})
		})

		it("スキルを一覧へ混ぜる。名前が衝突したらコマンド側を優先する", async () => {
			const skills: SkillMetadata[] = [
				// review はコマンド側と衝突するのでスキップされる。
				{ name: "review", description: "skill review", path: "/skills/review/SKILL.md", source: "global" },
				{ name: "deploy", description: "skill deploy", path: "/skills/deploy/SKILL.md", source: "project" },
				// 同名スキルが 2 つあっても 1 件だけ（existingCommandNames への add が効く）。
				{ name: "deploy", description: "dup", path: "/skills/deploy2/SKILL.md", source: "global" },
			]
			const getSkillsForMode = vi.fn(() => skills)
			const h = makeProvider({
				skillsManager: { getSkillsForMode },
				getStateImpl: async () => ({ mode: "architect" }),
			})
			getCommandsMock.mockResolvedValue([
				{ name: "review", source: "project", filePath: "/p/review.md", description: "cmd review" },
			])

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(getSkillsForMode).toHaveBeenCalledExactlyOnceWith("architect")
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "commands",
				commands: [
					{
						name: "review",
						source: "project",
						filePath: "/p/review.md",
						description: "cmd review",
						argumentHint: undefined,
					},
					{
						name: "deploy",
						source: "project",
						filePath: "/skills/deploy/SKILL.md",
						description: "skill deploy",
					},
				],
			})
		})

		it("実行中タスクのモードを最優先で使う", async () => {
			const getSkillsForMode = vi.fn(() => [] as SkillMetadata[])
			const h = makeProvider({
				task: { cwd: WORKSPACE_DIR, modeState: { getMode: async () => "debug" } },
				skillsManager: { getSkillsForMode },
				getStateImpl: async () => ({ mode: "architect" }),
			})

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(getSkillsForMode).toHaveBeenCalledExactlyOnceWith("debug")
			// タスクのモードが取れた時点で state は見に行かない。
			expect(h.getState).not.toHaveBeenCalled()
		})

		it("タスクのモード取得が失敗したらログを残してグローバル state のモードへ落ちる", async () => {
			const getSkillsForMode = vi.fn(() => [] as SkillMetadata[])
			const h = makeProvider({
				task: {
					cwd: WORKSPACE_DIR,
					modeState: {
						getMode: async () => {
							throw new Error("mode boom")
						},
					},
				},
				skillsManager: { getSkillsForMode },
				getStateImpl: async () => ({ mode: "ask" }),
			})

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error resolving current task mode"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("mode boom"))
			expect(getSkillsForMode).toHaveBeenCalledExactlyOnceWith("ask")
		})

		it("getState が失敗したらログを残して既定モードへ落ちる", async () => {
			const getSkillsForMode = vi.fn(() => [] as SkillMetadata[])
			const h = makeProvider({
				skillsManager: { getSkillsForMode },
				getStateImpl: async () => {
					throw new Error("state boom")
				},
			})

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error resolving global mode"))
			expect(getSkillsForMode).toHaveBeenCalledExactlyOnceWith(defaultModeSlug)
		})

		it.each([
			["mode が空文字", { mode: "" }],
			["mode が文字列でない", { mode: 42 }],
			["mode が無い", {}],
		])("%s なら既定モードで解決する", async (_label, state) => {
			const getSkillsForMode = vi.fn(() => [] as SkillMetadata[])
			const h = makeProvider({
				skillsManager: { getSkillsForMode },
				getStateImpl: async () => state as Record<string, unknown>,
			})

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(getSkillsForMode).toHaveBeenCalledExactlyOnceWith(defaultModeSlug)
		})

		it("getCommands が失敗したら空リストを返しつつログを残す", async () => {
			const h = makeProvider()
			getCommandsMock.mockRejectedValue(new Error("scan boom"))

			await handler("requestCommands")(h.provider, msg({ type: "requestCommands" }))

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error fetching commands"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("scan boom"))
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({ type: "commands", commands: [] })
		})
	})

	describe("openCommandFile", () => {
		it("見つかったコマンドのファイルをエディタで開く", async () => {
			const h = makeProvider()
			const filePath = path.join(PROJECT_COMMANDS_DIR, "review.md")
			getCommandMock.mockResolvedValue({ name: "review", source: "project", filePath })

			await handler("openCommandFile")(h.provider, msg({ type: "openCommandFile", text: "review" }))

			expect(getCommandMock).toHaveBeenCalledExactlyOnceWith(WORKSPACE_DIR, "review")
			expect(openFileMock).toHaveBeenCalledExactlyOnceWith(filePath)
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("text が無ければ何もしない", async () => {
			const h = makeProvider()

			await handler("openCommandFile")(h.provider, msg({ type: "openCommandFile" }))

			expect(getCommandMock).not.toHaveBeenCalled()
			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it.each([
			["コマンドが見つからない", undefined],
			["filePath が無い（built-in など）", { name: "init", source: "built-in" }],
		])("%s ならエラー表示だけしてファイルは開かない", async (_label, command) => {
			const h = makeProvider()
			getCommandMock.mockResolvedValue(command)

			await handler("openCommandFile")(h.provider, msg({ type: "openCommandFile", text: "init" }))

			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.command_not_found")
		})

		it("getCommand が投げてもログとエラー表示だけで握り潰す", async () => {
			const h = makeProvider()
			getCommandMock.mockRejectedValue(new Error("load boom"))

			await handler("openCommandFile")(h.provider, msg({ type: "openCommandFile", text: "review" }))

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error opening command file"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("load boom"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.open_command_file")
			expect(openFileMock).not.toHaveBeenCalled()
		})
	})

	describe("deleteCommand（不変条件 1：fs.unlink に渡るパス）", () => {
		it("見つかったコマンドファイルだけを消す", async () => {
			const h = makeProvider()
			useNaiveGetCommand([path.join(PROJECT_COMMANDS_DIR, "review.md")])

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "review", values: { source: "project" } }),
			)

			expect(unlinkPaths()).toEqual([path.join(PROJECT_COMMANDS_DIR, "review.md")])
			expectAllPathsDirectlyUnder(unlinkPaths(), PROJECT_COMMANDS_DIR)
			expect(h.log).toHaveBeenCalledWith(`Deleted command file: ${path.join(PROJECT_COMMANDS_DIR, "review.md")}`)
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("グローバルコマンドは ~/.agent/commands 配下だけを消す", async () => {
			const h = makeProvider()
			useNaiveGetCommand([path.join(GLOBAL_COMMANDS_DIR, "release.md")])

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "release", values: { source: "global" } }),
			)

			expect(unlinkPaths()).toEqual([path.join(GLOBAL_COMMANDS_DIR, "release.md")])
			expectAllPathsDirectlyUnder(unlinkPaths(), GLOBAL_COMMANDS_DIR)
		})

		it.each([
			["text が無い", { values: { source: "project" } }],
			["values が無い", { text: "review" }],
			["source が無い", { text: "review", values: {} }],
			["text が空文字", { text: "", values: { source: "project" } }],
			["source が空文字", { text: "review", values: { source: "" } }],
		])("%s なら fs.unlink は一度も呼ばれない", async (_label, extra) => {
			const h = makeProvider()
			useNaiveGetCommand([path.join(PROJECT_COMMANDS_DIR, "review.md")])

			await handler("deleteCommand")(h.provider, msg({ type: "deleteCommand", ...extra }))

			expect(unlinkMock).not.toHaveBeenCalled()
			expect(getCommandMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it.each([
			["コマンドが見つからない", undefined],
			["filePath が無い（built-in など）", { name: "init", source: "built-in" }],
		])("%s なら fs.unlink せずエラー表示だけ出す", async (_label, command) => {
			const h = makeProvider()
			getCommandMock.mockResolvedValue(command)

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "init", values: { source: "project" } }),
			)

			expect(unlinkMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.command_not_found")
		})

		it("fs.unlink が失敗してもログとエラー表示で握り潰す", async () => {
			const h = makeProvider()
			useNaiveGetCommand([path.join(PROJECT_COMMANDS_DIR, "review.md")])
			unlinkMock.mockRejectedValue(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }))

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "review", values: { source: "project" } }),
			)

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error deleting command"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("EPERM"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.delete_command")
			// 「消しました」ログは出ない。
			expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("Deleted command file"))
		})

		// 【不変条件 1】コマンド名がパスの 1 セグメントでなければ、パスを組ませる前に止める。
		//
		// message.text は webview 由来。getCommand（services/command/commands.ts の
		// tryLoadCommand）は `path.join(dir, `${name}.md`)` を組むだけでサニタイズしないので、
		// セパレータや ".." を通すとコマンドディレクトリの外の .md が unlink される。
		// getCommand を呼ぶ前に弾く＝実在するファイルを 1 件も触らない。
		it("【不変条件】コマンド名に '..' が入っても unlink まで到達しない", async () => {
			const h = makeProvider()
			// 抜けた先に実ファイルがある状況を作る。ガードが無ければここが消える。
			const escaped = path.join(WORKSPACE_DIR, "SECRET.md")
			useNaiveGetCommand([escaped])

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "../../SECRET", values: { source: "project" } }),
			)

			expect(unlinkMock).not.toHaveBeenCalled()
			expect(unlinkPaths()).toEqual([])
			// パスを組む getCommand 自体を呼ばない。
			expect(getCommandMock).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledExactlyOnceWith(
				'deleteCommand: refusing an unsafe command name "../../SECRET"',
			)
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.command_not_found")
		})

		it.each([
			// ワークスペースの外（ルート直下）まで抜けるケース。
			["親ディレクトリへ抜ける", "../../../../../etc/hosts"],
			["サブディレクトリを指す", "nested/inner"],
			["Windows セパレータ", "sub\\dir"],
			["カレントディレクトリそのもの", "."],
			["親ディレクトリそのもの", ".."],
			["先頭が絶対パス", "/etc/hosts"],
			["NUL を含む", "a\u0000b"],
		])("【不変条件】コマンド名 %s は unlink される前に拒否される", async (_label, name) => {
			const h = makeProvider()
			// 素朴に join した先に実ファイルがあっても消さない。
			useNaiveGetCommand([path.join(PROJECT_COMMANDS_DIR, `${name}.md`)])

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: name, values: { source: "project" } }),
			)

			expect(unlinkMock).not.toHaveBeenCalled()
			expect(getCommandMock).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledExactlyOnceWith(
				`deleteCommand: refusing an unsafe command name ${JSON.stringify(name)}`,
			)
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.command_not_found")
		})

		it("【バグ】シンボリックリンクのコマンドを消すとリンク先の実ファイルが消える", async () => {
			// getCommand は symlink を解決した「実体のパス」を filePath に入れて返す
			// （services/command/commands.ts の tryLoadCommand / scanCommandDirectory）。
			// deleteCommand はそれをそのまま unlink するので、リンクではなく本体が消える。
			const h = makeProvider()
			const realTarget = "/home/user/dotfiles/agent-commands/review.md"
			getCommandMock.mockResolvedValue({ name: "review", source: "project", filePath: realTarget })

			await handler("deleteCommand")(
				h.provider,
				msg({ type: "deleteCommand", text: "review", values: { source: "project" } }),
			)

			expect(unlinkPaths()).toEqual([realTarget])
			// コマンドディレクトリ配下ですらない。
			expect(realTarget.startsWith(PROJECT_COMMANDS_DIR)).toBe(false)
			expect(realTarget.startsWith(GLOBAL_COMMANDS_DIR)).toBe(false)
		})
	})

	describe("createCommand（不変条件 1：fs.mkdir / fs.writeFile に渡るパス）", () => {
		it("source が無ければ何も作らずログだけ残す", async () => {
			const h = makeProvider()

			await handler("createCommand")(h.provider, msg({ type: "createCommand", text: "foo" }))

			expect(h.log).toHaveBeenCalledExactlyOnceWith("Missing source for createCommand")
			expect(mkdirMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it("global なら ~/.agent/commands に作る", async () => {
			const h = makeProvider()

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "release", values: { source: "global" } }),
			)

			expect(mkdirPaths()).toEqual([GLOBAL_COMMANDS_DIR])
			expect(mkdirMock).toHaveBeenCalledExactlyOnceWith(GLOBAL_COMMANDS_DIR, { recursive: true })
			expect(writeFilePaths()).toEqual([path.join(GLOBAL_COMMANDS_DIR, "release.md")])
			expect(writeFileMock).toHaveBeenCalledExactlyOnceWith(
				path.join(GLOBAL_COMMANDS_DIR, "release.md"),
				"common:errors.command_template_content",
				"utf8",
			)
			expectAllPathsDirectlyUnder(writeFilePaths(), GLOBAL_COMMANDS_DIR)
			expect(openFileMock).toHaveBeenCalledExactlyOnceWith(path.join(GLOBAL_COMMANDS_DIR, "release.md"))
			expect(h.log).toHaveBeenCalledWith(
				`Created new command file: ${path.join(GLOBAL_COMMANDS_DIR, "release.md")}`,
			)
		})

		it("project なら <cwd>/.agent/commands に作り、作成後に一覧を投げ直す", async () => {
			const h = makeProvider()
			getCommandsMock.mockResolvedValue([
				{
					name: "deploy",
					source: "project",
					filePath: path.join(PROJECT_COMMANDS_DIR, "deploy.md"),
					description: "d",
					argumentHint: "a",
					content: "本文",
				},
			])

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(mkdirPaths()).toEqual([PROJECT_COMMANDS_DIR])
			expect(writeFilePaths()).toEqual([path.join(PROJECT_COMMANDS_DIR, "deploy.md")])
			expectAllPathsDirectlyUnder(writeFilePaths(), PROJECT_COMMANDS_DIR)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "commands",
				commands: [
					{
						name: "deploy",
						source: "project",
						filePath: path.join(PROJECT_COMMANDS_DIR, "deploy.md"),
						description: "d",
						argumentHint: "a",
					},
				],
			})
		})

		it.each([
			["workspaceFolders が undefined", undefined],
			["workspaceFolders が空", []],
		])("project かつ %s ならエラー表示だけして作らない", async (_label, folders) => {
			;(vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = folders
			const h = makeProvider()

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.no_workspace")
			expect(mkdirMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it("workspaceFolders はあるが cwd が空ならエラー表示だけして作らない", async () => {
			const h = makeProvider({ cwd: "" })

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				"common:errors.no_workspace_for_project_command",
			)
			expect(mkdirMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
		})

		it("既に同名ファイルがあれば上書きせずエラー表示する", async () => {
			const h = makeProvider()
			setExistingFiles([path.join(PROJECT_COMMANDS_DIR, "deploy.md")])

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(writeFileMock).not.toHaveBeenCalled()
			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.command_already_exists")
			// ディレクトリ作成までは進む。
			expect(mkdirPaths()).toEqual([PROJECT_COMMANDS_DIR])
		})

		it.each([
			["text 未指定", undefined],
			["空文字", ""],
			["空白のみ", "   "],
		])("名前が %s なら new-command を採番する", async (_label, text) => {
			const h = makeProvider()

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text, values: { source: "project" } }),
			)

			expect(writeFilePaths()).toEqual([path.join(PROJECT_COMMANDS_DIR, "new-command.md")])
			expectAllPathsDirectlyUnder(writeFilePaths(), PROJECT_COMMANDS_DIR)
		})

		it("new-command が埋まっていれば連番で空きを探す", async () => {
			const h = makeProvider()
			setExistingFiles([
				path.join(PROJECT_COMMANDS_DIR, "new-command.md"),
				path.join(PROJECT_COMMANDS_DIR, "new-command-1.md"),
			])

			await handler("createCommand")(h.provider, msg({ type: "createCommand", values: { source: "project" } }))

			// 存在確認は new-command → new-command-1 → new-command-2、
			// 最後に「作る直前の重複チェック」でもう一度 new-command-2。
			expect(accessPaths()).toEqual([
				path.join(PROJECT_COMMANDS_DIR, "new-command.md"),
				path.join(PROJECT_COMMANDS_DIR, "new-command-1.md"),
				path.join(PROJECT_COMMANDS_DIR, "new-command-2.md"),
				path.join(PROJECT_COMMANDS_DIR, "new-command-2.md"),
			])
			expect(writeFilePaths()).toEqual([path.join(PROJECT_COMMANDS_DIR, "new-command-2.md")])
			expectAllPathsDirectlyUnder(writeFilePaths(), PROJECT_COMMANDS_DIR)
		})

		it.each([
			["先頭スラッシュを外す", "/review", "review.md"],
			[".md 拡張子を外す", "review.md", "review.md"],
			[".MD 拡張子も外す（大文字小文字を無視）", "Review.MD", "review.md"],
			["空白をダッシュにする", "My New Command", "my-new-command.md"],
			["大文字を小文字にする", "REVIEW", "review.md"],
			["記号を落とす", "re@vi!ew#", "review.md"],
			["連続ダッシュをまとめる", "a---b", "a-b.md"],
			["前後のダッシュを落とす", "-review-", "review.md"],
			["前後の空白を落とす", "  review  ", "review.md"],
			["残りが空なら new-command", "@@@", "new-command.md"],
			["先頭スラッシュ＋.md＋空白の複合", "/ My Cmd.md ", "my-cmd.md"],
		])("名前の正規化: %s", async (_label, text, expectedFile) => {
			const h = makeProvider()

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text, values: { source: "project" } }),
			)

			expect(writeFilePaths()).toEqual([path.join(PROJECT_COMMANDS_DIR, expectedFile)])
		})

		it("【不変条件】どんなコマンド名でも書き込み先はコマンドディレクトリ直下から出ない", async () => {
			// 名前は webview / CLI からそのまま来る。ここが抜けると任意の場所に
			// .md を作られる（既存ファイルの上書きは fileExists で止まるが、新規作成は通る）。
			const hostileNames = [
				"../../../../etc/cron.d/evil",
				"..",
				".",
				"../secret",
				"a/b/c",
				"sub\\dir",
				"x\0y",
				"/etc/passwd",
				"~/.ssh/authorized_keys",
				"....//....//etc",
				"%2e%2e/%2e%2e/etc",
				"C:\\Windows\\system32\\evil",
				"   ../..   ",
				"..md",
				"...md",
			]

			for (const name of hostileNames) {
				vi.clearAllMocks()
				accessMock.mockImplementation(async () => {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
				})
				const h = makeProvider()

				await handler("createCommand")(
					h.provider,
					msg({ type: "createCommand", text: name, values: { source: "project" } }),
				)

				// mkdir 先も writeFile 先も、コマンドディレクトリの内側に収まる。
				expect(mkdirPaths()).toEqual([PROJECT_COMMANDS_DIR])
				expectAllPathsDirectlyUnder(writeFilePaths(), PROJECT_COMMANDS_DIR)
				expectAllPathsDirectlyUnder(accessPaths(), PROJECT_COMMANDS_DIR)
				// 拡張子も必ず .md（別種のファイルを作らない）。
				for (const p of writeFilePaths()) {
					expect(path.extname(p)).toBe(".md")
					expect(/^[a-z0-9-]+\.md$/.test(path.basename(p))).toBe(true)
				}
			}
		})

		it("グローバル側でも同じく ~/.agent/commands の外へは書かない", async () => {
			const h = makeProvider()

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "../../../../etc/evil", values: { source: "global" } }),
			)

			expectAllPathsDirectlyUnder(writeFilePaths(), GLOBAL_COMMANDS_DIR)
			expect(writeFilePaths()).toEqual([path.join(GLOBAL_COMMANDS_DIR, "etcevil.md")])
		})

		it("mkdir が失敗したら書き込まずログとエラー表示で握り潰す", async () => {
			const h = makeProvider()
			mkdirMock.mockRejectedValue(new Error("EACCES: permission denied"))

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(writeFileMock).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Error creating command"))
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("EACCES"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.create_command_failed")
		})

		it("writeFile が失敗したらエディタも開かず一覧も投げ直さない", async () => {
			const h = makeProvider()
			writeFileMock.mockRejectedValue(new Error("ENOSPC: no space left"))

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "deploy", values: { source: "project" } }),
			)

			expect(openFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.create_command_failed")
		})

		it("一覧の再取得は cwd 未設定でも空文字で呼ぶ（global 作成 & cwd 無し）", async () => {
			// createCommand の末尾は `resolveCurrentCwd(provider) || ""`。
			// global 作成なら cwd が空でもここまで到達する。
			;(vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = []
			const h = makeProvider({ cwd: "" })

			await handler("createCommand")(
				h.provider,
				msg({ type: "createCommand", text: "release", values: { source: "global" } }),
			)

			expect(writeFilePaths()).toEqual([path.join(GLOBAL_COMMANDS_DIR, "release.md")])
			expect(getCommandsMock).toHaveBeenCalledExactlyOnceWith("")
		})
	})
})
