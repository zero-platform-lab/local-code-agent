// npx vitest run core/webview/__tests__/customModesMessageHandlers.spec.ts
//
// customModesMessageHandlers は webview から来たメッセージだけを頼りに
//   - `fs.rm(rulesFolderPath, { recursive: true, force: true })`（利用者のワークスペース内を消す）
//   - `fs.writeFile(saveUri.fsPath, ...)`（保存ダイアログで選ばれた任意パスへ書く）
// を実行する。どちらも取り返しがつかないので、行数ではなく「消える／書かれる範囲」を固定する。
//
// ここで守る不変条件:
//   1. fs.rm に渡るパスが必ず `<workspace>/.agent/rules-<slug>` か `<home>/.agent/rules-<slug>`
//      であること（最重要）。slug は webview 由来の文字列がそのまま `rules-${slug}` に
//      埋め込まれるため、セパレータが混ざると path.join の正規化で上位ディレクトリへ抜ける。
//      危険な slug ではパスを組む前に throw して、fs.rm も存在確認も走らせないこと。
//   2. 削除の「確認」は checkOnly のラウンドトリップだけであり、その経路では fs.rm を呼ばないこと。
//      （拡張ホスト側に確認ダイアログは無い。確認は webview の DeleteModeDialog が持つ）
//   3. エクスポートの保存ダイアログをキャンセルしたら fs.writeFile を一度も呼ばないこと。
//   4. インポートで壊れた／不正な形の内容を渡しても、既存のモード（customModes state）を上書きしないこと。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { ModeConfig, WebviewMessage } from "@openai-agent/types"

import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const {
	rmMock,
	writeFileMock,
	readFileMock,
	fileExistsAtPathMock,
	openFileMock,
	homedirMock,
	showSaveDialogMock,
	showOpenDialogMock,
	showErrorMessageMock,
	showInformationMessageMock,
	workspaceState,
} = vi.hoisted(() => ({
	rmMock: vi.fn(async (..._args: unknown[]) => undefined),
	writeFileMock: vi.fn(async (..._args: unknown[]) => undefined),
	readFileMock: vi.fn(async (..._args: unknown[]) => ""),
	fileExistsAtPathMock: vi.fn(async (..._args: unknown[]) => true),
	openFileMock: vi.fn(async (..._args: unknown[]) => undefined),
	homedirMock: vi.fn(() => "/home/testuser"),
	showSaveDialogMock: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showOpenDialogMock: vi.fn(async (..._args: unknown[]) => undefined as unknown),
	showErrorMessageMock: vi.fn(),
	showInformationMessageMock: vi.fn(),
	// vscode.workspace.workspaceFolders をテストごとに差し替えるための箱。
	workspaceState: { folders: [] as { uri: { fsPath: string } }[] },
}))

// 実装は `import * as fs from "fs/promises"`、依存モジュール（utils/fs 等）は default import なので両方生やす。
vi.mock("fs/promises", () => {
	const api = { rm: rmMock, writeFile: writeFileMock, readFile: readFileMock }
	return { ...api, default: api }
})

// os.homedir() だけ差し替える。global スコープのルールフォルダと Downloads フォールバックが
// 実行環境のホームに依存すると、パスの検査が「どこを指しているのか」を言えなくなる。
vi.mock("os", async () => {
	const actual = await vi.importActual<typeof import("os")>("os")
	const api = { ...actual, homedir: homedirMock }
	return { ...api, default: api }
})

vi.mock("vscode", () => {
	const Uri = {
		file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" }),
		parse: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" }),
	}

	return {
		Uri,
		window: {
			activeTextEditor: undefined,
			showSaveDialog: showSaveDialogMock,
			showOpenDialog: showOpenDialogMock,
			showErrorMessage: showErrorMessageMock,
			showInformationMessage: showInformationMessageMock,
		},
		workspace: {
			get workspaceFolders() {
				return workspaceState.folders
			},
			getWorkspaceFolder: () => undefined,
			getConfiguration: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
		},
	}
})

// fileExistsAtPath だけ差し替える（本物は fs.access を叩くので、モックした fs/promises に引きずられる）。
vi.mock("../../../utils/fs", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/fs")>("../../../utils/fs")
	return { ...actual, fileExistsAtPath: fileExistsAtPathMock }
})

// getWorkspacePath は本物だと vscode.workspace.workspaceFolders を読むが、utils/path は
// vitest.setup.ts が先に import して共有の vscode モックで固まっているため、この spec の
// vi.mock("vscode") が効かない。本物と同じ規則（先頭のフォルダ、無ければ空文字）で差し替える。
vi.mock("../../../utils/path", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/path")>("../../../utils/path")
	return { ...actual, getWorkspacePath: () => workspaceState.folders.at(0)?.uri.fsPath ?? "" }
})

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: openFileMock }))

// t() は「キー＋パラメータ」をそのまま可視化する。文言ではなく「何が埋め込まれたか」を検査したい。
vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

import { customModesMessageHandlers } from "../customModesMessageHandlers"

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/workspace/project"
const HOME_DIR = "/home/testuser"

/** そのモードのルールフォルダの想定パス。 */
const rulesDir = (root: string, slug: string) => path.join(root, ".agent", `rules-${slug}`)

/** fs.rm に渡った第 1 引数（＝消えるパス）を呼ばれた順に全件返す。 */
const rmPaths = (): string[] => rmMock.mock.calls.map((call) => call[0] as string)

/** fs.writeFile に渡った (パス, 内容, エンコーディング) を全件返す。 */
const writeFileCalls = (): unknown[][] => writeFileMock.mock.calls.map((call) => [...call])

/**
 * fs.rm に渡った全パスが `<root>/.agent/rules-<1 セグメント>` の形であることを検査する。
 *
 * ここが崩れると「モード 1 つのつもりが .agent ごと」「ワークスペースごと」消える。
 * recursive+force の rm なので、消えたことに気づく手段も戻す手段も無い。
 * 削除が走るケースでは期待値の assertion とは別に必ずこの形を通す。
 */
function expectAllRmPathsInsideAgentDir(root: string): void {
	const agentDir = path.join(root, ".agent")

	for (const p of rmPaths()) {
		expect(path.dirname(p)).toBe(agentDir)

		const segment = path.basename(p)
		expect(segment.startsWith("rules-")).toBe(true)
		// `rules-` だけ＝slug が空。ルールフォルダではなく別物を指している。
		expect(segment).not.toBe("rules-")
		// 正規化しても同じ場所へ戻る＝上位へ抜けていない。
		expect(path.resolve(p)).toBe(path.join(agentDir, segment))
	}
}

/**
 * fs.rm が触ってよい根。project スコープはワークスペース、global スコープはホーム。
 * ここに無い場所へ rm が飛んだ時点で、モード 1 つの削除では済んでいない。
 */
const RM_ALLOWED_ROOTS = [WORKSPACE_DIR, HOME_DIR]

/**
 * fs.rm に渡った全パスが `<workspace>/.agent/rules-<1 セグメント>` か
 * `<home>/.agent/rules-<1 セグメント>` のどちらかであることを検査する。
 *
 * 根を問わない版。ファイル末尾の afterEach で全テストに対して自動的に通しているので、
 * 「この spec のどのケースを通っても rm はこの 2 か所の外へ出ない」が保証される。
 */
function expectAllRmPathsAreRulesFolders(): void {
	const allowedAgentDirs = RM_ALLOWED_ROOTS.map((root) => path.join(root, ".agent"))

	for (const p of rmPaths()) {
		// 相対パスは拡張ホストの cwd 基準で解決されるので、行き先が実行環境依存になる。
		expect(path.isAbsolute(p)).toBe(true)
		// 正規化しても文字列が変わらない＝`..`/`.` で抜けていない。
		expect(path.normalize(p)).toBe(p)
		expect(allowedAgentDirs).toContain(path.dirname(p))

		const segment = path.basename(p)
		expect(segment.startsWith("rules-")).toBe(true)
		// `rules-` だけ＝slug が空。ルールフォルダではなく別物を指している。
		expect(segment).not.toBe("rules-")
	}
}

/** 破壊的な副作用が一切起きていないこと。「呼ばれないこと」の検査はまとめて通す。 */
function expectNoDestructiveCall(): void {
	expect(rmMock).not.toHaveBeenCalled()
	expect(writeFileMock).not.toHaveBeenCalled()
}

interface SetupOptions {
	/** customModesManager.getCustomModes() が返すモード一覧。 */
	customModes?: ModeConfig[]
	/** contextProxy.getValue の戻り値。 */
	values?: Record<string, unknown>
	/** ワークスペースフォルダ（省略時は WORKSPACE_DIR 1 つ）。 */
	workspaceFolders?: string[]
}

function mode(slug: string, source?: "global" | "project"): ModeConfig {
	return {
		slug,
		name: `mode ${slug}`,
		roleDefinition: "role",
		groups: [],
		...(source === undefined ? {} : { source }),
	}
}

function setup(options: SetupOptions = {}) {
	workspaceState.folders = (options.workspaceFolders ?? [WORKSPACE_DIR]).map((fsPath) => ({ uri: { fsPath } }))

	const values = new Map<string, unknown>(Object.entries(options.values ?? {}))

	const getValue = vi.fn((key: string) => values.get(key))
	const setValue = vi.fn(async (key: string, value: unknown) => {
		values.set(key, value)
	})

	const getCustomModes = vi.fn(async () => options.customModes ?? [])
	const getCustomModesFilePath = vi.fn(async () => "/settings/custom_modes.yaml")
	const checkRulesDirectoryHasContent = vi.fn(async (_slug: string) => true)
	const updateCustomMode = vi.fn(async (..._args: unknown[]) => undefined)
	const deleteCustomMode = vi.fn(async (_slug: string) => undefined)
	const exportModeWithRules = vi.fn(async (..._args: unknown[]) => ({ success: true, yaml: "yaml: content" }))
	const importModeWithRules = vi.fn(async (..._args: unknown[]) => ({ success: true, slug: "imported" }))

	const log = vi.fn()
	const postMessageToWebview = vi.fn(async (..._args: unknown[]) => undefined)
	const postStateToWebview = vi.fn(async () => undefined)
	const handleModeSwitch = vi.fn(async (..._args: unknown[]) => undefined)
	const getModes = vi.fn(async () => [{ slug: "code", name: "Code" }])

	const provider = {
		log,
		postMessageToWebview,
		postStateToWebview,
		handleModeSwitch,
		getModes,
		contextProxy: { getValue, setValue },
		customModesManager: {
			getCustomModes,
			getCustomModesFilePath,
			checkRulesDirectoryHasContent,
			updateCustomMode,
			deleteCustomMode,
			exportModeWithRules,
			importModeWithRules,
		},
	} as unknown as WebviewMessageHost

	/** ハンドラを型名で呼ぶ。未定義なら（＝ハンドラが消えたら）テストを落とす。 */
	const invoke = async (type: keyof typeof customModesMessageHandlers, message: Record<string, unknown> = {}) => {
		const handler = customModesMessageHandlers[type]

		if (!handler) {
			throw new Error(`handler not registered: ${String(type)}`)
		}

		await handler(provider, { type, ...message } as unknown as WebviewMessage)
	}

	return {
		provider,
		invoke,
		values,
		getValue,
		setValue,
		getCustomModes,
		getCustomModesFilePath,
		checkRulesDirectoryHasContent,
		updateCustomMode,
		deleteCustomMode,
		exportModeWithRules,
		importModeWithRules,
		log,
		postMessageToWebview,
		postStateToWebview,
		handleModeSwitch,
		getModes,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	rmMock.mockImplementation(async () => undefined)
	writeFileMock.mockImplementation(async () => undefined)
	readFileMock.mockImplementation(async () => "")
	fileExistsAtPathMock.mockImplementation(async () => true)
	homedirMock.mockImplementation(() => HOME_DIR)
	showSaveDialogMock.mockImplementation(async () => undefined)
	showOpenDialogMock.mockImplementation(async () => undefined)
})

// どのテストを通っても fs.rm の行き先が 2 か所のルールフォルダから出ないことを、
// 個別の期待値とは別にファイル全体で見張る。rm が呼ばれないケースでは素通りする。
afterEach(() => {
	expectAllRmPathsAreRulesFolders()
})

// ---------------------------------------------------------------------------

describe("customModesMessageHandlers", () => {
	describe("openCustomModesSettings", () => {
		it("設定ファイルのパスが取れたら開く", async () => {
			const h = setup()

			await h.invoke("openCustomModesSettings")

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith("/settings/custom_modes.yaml")
			expectNoDestructiveCall()
		})

		it("パスが空なら何も開かない", async () => {
			const h = setup()
			h.getCustomModesFilePath.mockResolvedValue("")

			await h.invoke("openCustomModesSettings")

			expect(openFileMock).not.toHaveBeenCalled()
		})
	})

	describe("mode / hasOpenedModeSelector", () => {
		it("mode は text をそのままモード切替に渡す", async () => {
			const h = setup()

			await h.invoke("mode", { text: "architect" })

			expect(h.handleModeSwitch).toHaveBeenCalledExactlyOnceWith("architect")
		})

		it("hasOpenedModeSelector は bool をそのまま保存する（false も false のまま）", async () => {
			const h = setup()

			await h.invoke("hasOpenedModeSelector", { bool: false })

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("hasOpenedModeSelector", false)
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("hasOpenedModeSelector は bool 省略時に true とみなす", async () => {
			const h = setup()

			await h.invoke("hasOpenedModeSelector")

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("hasOpenedModeSelector", true)
		})
	})

	describe("requestModes", () => {
		it("モード一覧をそのまま webview へ返す", async () => {
			const h = setup()

			await h.invoke("requestModes")

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "modes",
				modes: [{ slug: "code", name: "Code" }],
			})
		})

		it("取得に失敗しても空配列を返して webview を止めない", async () => {
			const h = setup()
			h.getModes.mockRejectedValue(new Error("modes boom"))

			await h.invoke("requestModes")

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("modes boom"))
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({ type: "modes", modes: [] })
		})
	})

	describe("checkRulesDirectory", () => {
		it("slug が無ければ問い合わせない", async () => {
			const h = setup()

			await h.invoke("checkRulesDirectory", {})

			expect(h.checkRulesDirectoryHasContent).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("slug があれば有無をそのまま返す", async () => {
			const h = setup()
			h.checkRulesDirectoryHasContent.mockResolvedValue(false)

			await h.invoke("checkRulesDirectory", { slug: "my-mode" })

			expect(h.checkRulesDirectoryHasContent).toHaveBeenCalledExactlyOnceWith("my-mode")
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "checkRulesDirectoryResult",
				slug: "my-mode",
				hasContent: false,
			})
		})
	})

	describe("updateCustomMode", () => {
		it("modeConfig が無ければ何もしない", async () => {
			const h = setup()

			await h.invoke("updateCustomMode", {})

			expect(h.updateCustomMode).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
		})

		it("保存後に customModes と現在モードを state へ反映する", async () => {
			const modes = [mode("my-mode", "project")]
			const h = setup({ customModes: modes })

			await h.invoke("updateCustomMode", { modeConfig: modes[0] })

			expect(h.updateCustomMode).toHaveBeenCalledExactlyOnceWith("my-mode", modes[0])
			expect(h.setValue).toHaveBeenCalledWith("customModes", modes)
			expect(h.setValue).toHaveBeenCalledWith("mode", "my-mode")
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("保存に失敗したら state を一切書き換えない（エラーは既に利用者へ出ている）", async () => {
			const modes = [mode("my-mode", "project")]
			const h = setup({ customModes: modes })
			h.updateCustomMode.mockRejectedValue(new Error("validation failed"))

			await expect(h.invoke("updateCustomMode", { modeConfig: modes[0] })).resolves.toBeUndefined()

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})
	})

	// -----------------------------------------------------------------------
	// deleteCustomMode: 不変条件 1 / 2
	// -----------------------------------------------------------------------
	describe("deleteCustomMode: 削除しない経路", () => {
		it("slug が無ければ何も消さない", async () => {
			const h = setup({ customModes: [mode("my-mode", "project")] })

			await h.invoke("deleteCustomMode", {})

			expect(h.getCustomModes).not.toHaveBeenCalled()
			expect(h.deleteCustomMode).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})

		it("一覧に無い slug なら何も消さない（存在しないモードの削除要求）", async () => {
			const h = setup({ customModes: [mode("other", "project")] })

			await h.invoke("deleteCustomMode", { slug: "ghost" })

			expect(h.deleteCustomMode).not.toHaveBeenCalled()
			expect(fileExistsAtPathMock).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})

		it("【不変条件】checkOnly のラウンドトリップでは fs.rm を一度も呼ばず、削除もしない", async () => {
			// 拡張ホスト側に確認ダイアログは無い。確認は webview の DeleteModeDialog が持ち、
			// この checkOnly 応答（deleteCustomModeCheck）がその材料になる。
			// つまり「利用者が拒否した」＝ checkOnly の後に本削除メッセージが来ない、という形でしか表現されない。
			const h = setup({ customModes: [mode("my-mode", "project")] })

			await h.invoke("deleteCustomMode", { slug: "my-mode", checkOnly: true })

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "deleteCustomModeCheck",
				slug: "my-mode",
				rulesFolderPath: rulesDir(WORKSPACE_DIR, "my-mode"),
			})
			expect(h.deleteCustomMode).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})

		it("checkOnly でルールフォルダが無ければ rulesFolderPath は undefined で返す", async () => {
			const h = setup({ customModes: [mode("my-mode", "project")] })
			fileExistsAtPathMock.mockResolvedValue(false)

			await h.invoke("deleteCustomMode", { slug: "my-mode", checkOnly: true })

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "deleteCustomModeCheck",
				slug: "my-mode",
				rulesFolderPath: undefined,
			})
			expectNoDestructiveCall()
		})

		it("ルールフォルダが存在しなければモードだけ消し、fs.rm は呼ばない", async () => {
			const h = setup({ customModes: [mode("my-mode", "project")] })
			fileExistsAtPathMock.mockResolvedValue(false)

			await h.invoke("deleteCustomMode", { slug: "my-mode" })

			expect(h.deleteCustomMode).toHaveBeenCalledExactlyOnceWith("my-mode")
			expect(rmMock).not.toHaveBeenCalled()
			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("mode", "code")
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})
	})

	describe("deleteCustomMode: 消える範囲（不変条件 1）", () => {
		it("project スコープはワークスペース直下の .agent/rules-<slug> だけを消す", async () => {
			const h = setup({ customModes: [mode("my-mode", "project"), mode("other", "project")] })

			await h.invoke("deleteCustomMode", { slug: "my-mode" })

			expect(fileExistsAtPathMock).toHaveBeenCalledExactlyOnceWith(rulesDir(WORKSPACE_DIR, "my-mode"))
			expect(rmPaths()).toEqual([rulesDir(WORKSPACE_DIR, "my-mode")])
			expect(rmMock.mock.calls[0][1]).toEqual({ recursive: true, force: true })
			// 無関係なモードのフォルダは 1 度も現れない。
			expect(rmPaths()).not.toContain(rulesDir(WORKSPACE_DIR, "other"))
			// ワークスペース自体や .agent 自体は消さない。
			expect(rmPaths()).not.toContain(WORKSPACE_DIR)
			expect(rmPaths()).not.toContain(path.join(WORKSPACE_DIR, ".agent"))
			expectAllRmPathsInsideAgentDir(WORKSPACE_DIR)
			expect(h.log).toHaveBeenCalledWith(
				`Deleted rules folder for mode my-mode: ${rulesDir(WORKSPACE_DIR, "my-mode")}`,
			)
			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("mode", "code")
		})

		it("source 未設定のモードは global 扱いになりホーム直下を消す", async () => {
			const h = setup({ customModes: [mode("my-mode")] })

			await h.invoke("deleteCustomMode", { slug: "my-mode" })

			expect(rmPaths()).toEqual([rulesDir(HOME_DIR, "my-mode")])
			expect(rmPaths()).not.toContain(path.join(HOME_DIR, ".agent"))
			expect(rmPaths()).not.toContain(HOME_DIR)
			expectAllRmPathsInsideAgentDir(HOME_DIR)
		})

		it("global スコープはホーム直下の .agent/rules-<slug> を消す", async () => {
			const h = setup({ customModes: [mode("my-mode", "global")] })

			await h.invoke("deleteCustomMode", { slug: "my-mode" })

			expect(rmPaths()).toEqual([rulesDir(HOME_DIR, "my-mode")])
			expectAllRmPathsInsideAgentDir(HOME_DIR)
		})

		it("【不変条件】ワークスペースが開かれていない project モードは相対パスを組まずに拒否する", async () => {
			// 絶対パスにできない状況で `.agent/rules-<slug>` を返すと、fs.rm が拡張ホストの
			// cwd 基準で解決する。どこが消えるかが実行環境依存になるので、組む前に落とす。
			const h = setup({ customModes: [mode("my-mode", "project")], workspaceFolders: [] })

			await expect(h.invoke("deleteCustomMode", { slug: "my-mode" })).rejects.toThrow(
				"Refusing to build a relative rules folder path with no workspace open",
			)

			// パスが無いので存在確認もモード削除も走らない。
			expect(fileExistsAtPathMock).not.toHaveBeenCalled()
			expect(h.deleteCustomMode).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})

		it("【不変条件】スキーマが通す slug（英数字とハイフンのみ）では .agent の 1 つ下から出ない", async () => {
			// modeConfigSchema の slug は /^[a-zA-Z0-9-]+$/。この範囲では正規化しても抜けない。
			const safeSlugs = ["a", "my-mode", "MODE-42", "----", "0", "a".repeat(120)]

			for (const slug of safeSlugs) {
				vi.clearAllMocks()
				const h = setup({ customModes: [mode(slug, "project")] })

				await h.invoke("deleteCustomMode", { slug })

				expect(rmPaths()).toEqual([rulesDir(WORKSPACE_DIR, slug)])
				expectAllRmPathsInsideAgentDir(WORKSPACE_DIR)
			}
		})

		it("【不変条件】危険な slug でも .agent の外へ fs.rm が飛ばない", async () => {
			// `rules-../..` は path.join の正規化で `.agent` 自身を指す。
			// resolveRulesFolderPath がパスを組む前に throw するので、rm は 1 度も呼ばれない。
			const h = setup({ customModes: [mode("../..", "project")] })

			await expect(h.invoke("deleteCustomMode", { slug: "../.." })).rejects.toThrow(
				"Refusing to build a rules folder path for an unsafe mode slug",
			)

			expect(rmMock).not.toHaveBeenCalled()
			expectAllRmPathsInsideAgentDir(WORKSPACE_DIR)
		})

		// 1 セグメントとして安全でない slug。左が slug、右は「ガードが無かった頃の行き先」。
		// modeConfigSchema の slug 正規表現 /^[a-zA-Z0-9-]+$/ はここを全部弾くが、
		// 検証を通らない経路が 1 つ増えるだけで復元不能な削除になるため、パスを組む側でも止める。
		const unsafeSlugs: [slug: string, formerTarget: string][] = [
			["..", "`rules-..` という名前のフォルダ"],
			[".", "`rules-.` という名前のフォルダ"],
			["a/b", "`rules-a/b`（.agent の中だが別フォルダ配下）"],
			["a\\b", "Windows では `rules-a\\b` が別フォルダ配下"],
			["../..", ".agent ディレクトリごと"],
			["../../..", "ルート（ワークスペース／ホーム）ごと"],
			["../../../..", "そのさらに親ごと"],
			["/etc", "絶対パスで指した先"],
			["a\0b", "NUL 入り（パス API が受け付けない）"],
		]

		it.each(unsafeSlugs)(
			"【不変条件】project スコープの slug=%j はパスを組む前に拒否する（以前は %s へ fs.rm が飛んでいた）",
			async (slug, _formerTarget) => {
				const h = setup({ customModes: [mode(slug, "project")] })

				// resolveRulesFolderPath の throw はハンドラ内で捕捉されない。
				// webviewMessageHandler も ClineProvider の onDidReceiveMessage も
				// try/catch を持たないので、例外はそのまま呼び出し側へ伝わる。
				await expect(h.invoke("deleteCustomMode", { slug })).rejects.toThrow(
					`Refusing to build a rules folder path for an unsafe mode slug: ${JSON.stringify(slug)}`,
				)

				// パスを組む前で落ちる＝存在確認すら走らない。
				expect(fileExistsAtPathMock).not.toHaveBeenCalled()
				// モード本体も消さない（削除は rm より後の行にある）。
				expect(h.deleteCustomMode).not.toHaveBeenCalled()
				expect(h.setValue).not.toHaveBeenCalled()
				expect(h.postStateToWebview).not.toHaveBeenCalled()
				expectNoDestructiveCall()
			},
		)

		it.each(unsafeSlugs)(
			"【不変条件】global スコープの slug=%j も同じく拒否する（以前は %s へ fs.rm が飛んでいた）",
			async (slug, _formerTarget) => {
				// global スコープの根はホーム。抜けた先はワークスペースではなく利用者の $HOME。
				const h = setup({ customModes: [mode(slug, "global")] })

				await expect(h.invoke("deleteCustomMode", { slug })).rejects.toThrow(
					`Refusing to build a rules folder path for an unsafe mode slug: ${JSON.stringify(slug)}`,
				)

				expect(fileExistsAtPathMock).not.toHaveBeenCalled()
				expect(h.deleteCustomMode).not.toHaveBeenCalled()
				expectNoDestructiveCall()
			},
		)

		it("【不変条件】危険な slug では checkOnly でも何も返さずに拒否する", async () => {
			// checkOnly はパスを webview へ返す経路。ここで組めてしまうと
			// 「削除確認ダイアログに .agent 自身が表示される」ことになる。
			const h = setup({ customModes: [mode("../../..", "project")] })

			await expect(h.invoke("deleteCustomMode", { slug: "../../..", checkOnly: true })).rejects.toThrow(
				"Refusing to build a rules folder path for an unsafe mode slug",
			)

			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expect(fileExistsAtPathMock).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})
	})

	describe("deleteCustomMode: 削除の失敗", () => {
		it("fs.rm が失敗してもモード削除は完了扱いにし、利用者へ通知する", async () => {
			const h = setup({ customModes: [mode("my-mode", "project")] })
			rmMock.mockRejectedValue(new Error("EPERM: operation not permitted"))

			await expect(h.invoke("deleteCustomMode", { slug: "my-mode" })).resolves.toBeUndefined()

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("EPERM: operation not permitted"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				`common:errors.delete_rules_folder_failed:${JSON.stringify({
					rulesFolderPath: rulesDir(WORKSPACE_DIR, "my-mode"),
					error: "EPERM: operation not permitted",
				})}`,
			)
			// フォルダが残ってもモードは消えたまま。既定モードへ戻して state を流す。
			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("mode", "code")
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("fs.rm が Error 以外を投げても String 化して通知する", async () => {
			const h = setup({ customModes: [mode("my-mode", "project")] })
			rmMock.mockRejectedValue("rm-string-failure")

			await h.invoke("deleteCustomMode", { slug: "my-mode" })

			expect(showErrorMessageMock).toHaveBeenCalledWith(expect.stringContaining("rm-string-failure"))
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})
	})

	// -----------------------------------------------------------------------
	// exportMode: 不変条件 3
	// -----------------------------------------------------------------------
	describe("exportMode", () => {
		const saveUri = { fsPath: "/tmp/exports/my-mode-export.yaml" }

		it("slug が無ければ何もしない", async () => {
			const h = setup()

			await h.invoke("exportMode", {})

			expect(h.exportModeWithRules).not.toHaveBeenCalled()
			expect(showSaveDialogMock).not.toHaveBeenCalled()
			expectNoDestructiveCall()
		})

		it("選ばれたパスへ YAML を書き、成功を webview と利用者へ伝える", async () => {
			const h = setup({
				values: { customModePrompts: { "my-mode": { roleDefinition: "custom role" } } },
			})
			showSaveDialogMock.mockResolvedValue(saveUri)

			await h.invoke("exportMode", { slug: "my-mode" })

			// カスタムプロンプトはマージ用にそのまま渡る。
			expect(h.exportModeWithRules).toHaveBeenCalledExactlyOnceWith("my-mode", { roleDefinition: "custom role" })
			expect(writeFileCalls()).toEqual([[saveUri.fsPath, "yaml: content", "utf-8"]])
			// 次回のためのディレクトリ記憶。
			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("lastModeExportPath", saveUri.fsPath)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: true,
				slug: "my-mode",
			})
			expect(showInformationMessageMock).toHaveBeenCalledExactlyOnceWith(
				`common:info.mode_exported:${JSON.stringify({ mode: "my-mode" })}`,
			)
			expect(rmMock).not.toHaveBeenCalled()
		})

		it("カスタムプロンプトが未設定なら undefined を渡す", async () => {
			const h = setup()
			showSaveDialogMock.mockResolvedValue(saveUri)

			await h.invoke("exportMode", { slug: "my-mode" })

			expect(h.exportModeWithRules).toHaveBeenCalledExactlyOnceWith("my-mode", undefined)
		})

		it("既定の保存先は前回のエクスポート先 → ワークスペース → Downloads の順で決まる", async () => {
			// 前回のパスがあればそのディレクトリ。
			const withLast = setup({ values: { lastModeExportPath: "/prev/dir/old.yaml" } })
			showSaveDialogMock.mockResolvedValue(saveUri)
			await withLast.invoke("exportMode", { slug: "my-mode" })
			expect((showSaveDialogMock.mock.calls[0][0] as { defaultUri: { fsPath: string } }).defaultUri.fsPath).toBe(
				path.join("/prev/dir", "my-mode-export.yaml"),
			)

			// 無ければワークスペース直下。
			vi.clearAllMocks()
			showSaveDialogMock.mockResolvedValue(saveUri)
			const withWorkspace = setup()
			await withWorkspace.invoke("exportMode", { slug: "my-mode" })
			expect((showSaveDialogMock.mock.calls[0][0] as { defaultUri: { fsPath: string } }).defaultUri.fsPath).toBe(
				path.join(WORKSPACE_DIR, "my-mode-export.yaml"),
			)

			// ワークスペースも無ければ Downloads。
			vi.clearAllMocks()
			showSaveDialogMock.mockResolvedValue(saveUri)
			const noWorkspace = setup({ workspaceFolders: [] })
			await noWorkspace.invoke("exportMode", { slug: "my-mode" })
			expect((showSaveDialogMock.mock.calls[0][0] as { defaultUri: { fsPath: string } }).defaultUri.fsPath).toBe(
				path.join(HOME_DIR, "Downloads", "my-mode-export.yaml"),
			)
		})

		it("【不変条件】保存ダイアログをキャンセルしたら fs.writeFile を一度も呼ばない", async () => {
			const h = setup()
			showSaveDialogMock.mockResolvedValue(undefined)

			await h.invoke("exportMode", { slug: "my-mode" })

			expect(writeFileMock).not.toHaveBeenCalled()
			// キャンセル時は保存先の記憶も更新しない。
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: false,
				error: "Export cancelled",
				slug: "my-mode",
			})
			expect(showInformationMessageMock).not.toHaveBeenCalled()
		})

		it("エクスポート生成が失敗したらダイアログすら出さない", async () => {
			const h = setup()
			h.exportModeWithRules.mockResolvedValue({ success: false, error: "mode not found" } as never)

			await h.invoke("exportMode", { slug: "my-mode" })

			expect(showSaveDialogMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: false,
				error: "mode not found",
				slug: "my-mode",
			})
		})

		it("success でも yaml が空ならダイアログを出さない", async () => {
			const h = setup()
			h.exportModeWithRules.mockResolvedValue({ success: true, yaml: "" } as never)

			await h.invoke("exportMode", { slug: "my-mode" })

			expect(showSaveDialogMock).not.toHaveBeenCalled()
			expect(writeFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: false,
				error: undefined,
				slug: "my-mode",
			})
		})

		it("書き込みが失敗したら失敗として webview へ返す（成功通知は出さない）", async () => {
			const h = setup()
			showSaveDialogMock.mockResolvedValue(saveUri)
			writeFileMock.mockRejectedValue(new Error("ENOSPC: no space left"))

			await expect(h.invoke("exportMode", { slug: "my-mode" })).resolves.toBeUndefined()

			expect(h.log).toHaveBeenCalledWith(expect.stringContaining("ENOSPC: no space left"))
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: false,
				error: "ENOSPC: no space left",
				slug: "my-mode",
			})
			expect(showInformationMessageMock).not.toHaveBeenCalled()
		})

		it("Error 以外が投げられても String 化して返す", async () => {
			const h = setup()
			h.exportModeWithRules.mockRejectedValue({ code: "EACCES" })

			await h.invoke("exportMode", { slug: "my-mode" })

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "exportModeResult",
				success: false,
				error: "[object Object]",
				slug: "my-mode",
			})
		})
	})

	// -----------------------------------------------------------------------
	// importMode: 不変条件 4
	// -----------------------------------------------------------------------
	describe("importMode", () => {
		const pickedUri = { fsPath: "/downloads/some-mode.yaml" }

		it("選んだファイルを読み込み、既定では project スコープへ取り込む", async () => {
			const modes = [mode("imported", "project")]
			const h = setup({ customModes: modes })
			showOpenDialogMock.mockResolvedValue([pickedUri])
			readFileMock.mockResolvedValue("customModes:\n  - slug: imported\n")

			await h.invoke("importMode", {})

			expect(readFileMock).toHaveBeenCalledExactlyOnceWith(pickedUri.fsPath, "utf-8")
			expect(h.importModeWithRules).toHaveBeenCalledExactlyOnceWith(
				"customModes:\n  - slug: imported\n",
				"project",
			)
			expect(h.setValue).toHaveBeenCalledWith("lastModeImportPath", pickedUri.fsPath)
			expect(h.setValue).toHaveBeenCalledWith("customModes", modes)
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: true,
				slug: "imported",
			})
			expect(showInformationMessageMock).toHaveBeenCalledExactlyOnceWith("common:info.mode_imported")
			expect(rmMock).not.toHaveBeenCalled()
		})

		it("source が指定されていればそのスコープへ取り込む", async () => {
			const h = setup()
			showOpenDialogMock.mockResolvedValue([pickedUri])

			await h.invoke("importMode", { source: "global" })

			expect(h.importModeWithRules).toHaveBeenCalledExactlyOnceWith("", "global")
		})

		it("既定の参照先は前回のインポート元 → ワークスペース → 未指定の順で決まる", async () => {
			const withLast = setup({ values: { lastModeImportPath: "/prev/import/old.yaml" } })
			await withLast.invoke("importMode", {})
			expect(
				(showOpenDialogMock.mock.calls[0][0] as { defaultUri?: { fsPath: string } }).defaultUri?.fsPath,
			).toBe("/prev/import")

			vi.clearAllMocks()
			const withWorkspace = setup()
			await withWorkspace.invoke("importMode", {})
			expect(
				(showOpenDialogMock.mock.calls[0][0] as { defaultUri?: { fsPath: string } }).defaultUri?.fsPath,
			).toBe(WORKSPACE_DIR)

			vi.clearAllMocks()
			const noWorkspace = setup({ workspaceFolders: [] })
			await noWorkspace.invoke("importMode", {})
			expect((showOpenDialogMock.mock.calls[0][0] as { defaultUri?: unknown }).defaultUri).toBeUndefined()
		})

		it("【不変条件】ファイル選択をキャンセルしたら読み込みも state 更新もしない", async () => {
			const h = setup()
			showOpenDialogMock.mockResolvedValue(undefined)

			await h.invoke("importMode", {})

			expect(readFileMock).not.toHaveBeenCalled()
			expect(h.importModeWithRules).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: false,
				error: "cancelled",
			})
			expectNoDestructiveCall()
		})

		it("空配列が返ってきた場合もキャンセル扱いにする", async () => {
			const h = setup()
			showOpenDialogMock.mockResolvedValue([])

			await h.invoke("importMode", {})

			expect(readFileMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: false,
				error: "cancelled",
			})
		})

		it("【不変条件】不正な形の内容を取り込もうとしても既存の customModes を上書きしない", async () => {
			// 「YAML ではあるが customModes の形をしていない」= importModeWithRules が失敗を返すケース。
			const h = setup({
				customModes: [mode("existing", "project")],
				values: { customModes: [mode("existing", "project")] },
			})
			showOpenDialogMock.mockResolvedValue([pickedUri])
			readFileMock.mockResolvedValue('{"customModes": [{"slug": "bad slug!"}]')
			h.importModeWithRules.mockResolvedValue({ success: false, error: "Invalid mode format" } as never)

			await h.invoke("importMode", {})

			// 記憶するのは参照ディレクトリだけ。customModes には触らない。
			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("lastModeImportPath", pickedUri.fsPath)
			expect(h.values.get("customModes")).toEqual([mode("existing", "project")])
			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: false,
				error: "Invalid mode format",
			})
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				`common:errors.mode_import_failed:${JSON.stringify({ error: "Invalid mode format" })}`,
			)
			expectNoDestructiveCall()
		})

		it("【不変条件】パースで例外が飛んでも既存の customModes を上書きしない", async () => {
			const h = setup({ values: { customModes: [mode("existing", "project")] } })
			showOpenDialogMock.mockResolvedValue([pickedUri])
			// 壊れた JSON / YAML は importModeWithRules の中で throw されうる。
			h.importModeWithRules.mockRejectedValue(new SyntaxError("Unexpected end of JSON input"))

			await expect(h.invoke("importMode", {})).resolves.toBeUndefined()

			expect(h.values.get("customModes")).toEqual([mode("existing", "project")])
			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith("Failed to import mode: Unexpected end of JSON input")
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: false,
				error: "Unexpected end of JSON input",
			})
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				`common:errors.mode_import_failed:${JSON.stringify({ error: "Unexpected end of JSON input" })}`,
			)
			expectNoDestructiveCall()
		})

		it("ファイル読み込み自体が失敗しても Error 以外を String 化して返す", async () => {
			const h = setup()
			showOpenDialogMock.mockResolvedValue([pickedUri])
			readFileMock.mockRejectedValue("EISDIR")

			await h.invoke("importMode", {})

			expect(h.importModeWithRules).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "importModeResult",
				success: false,
				error: "EISDIR",
			})
		})
	})
})
