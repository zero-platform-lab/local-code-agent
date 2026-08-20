// npx vitest run core/tools/__tests__/ApplyPatchTool.spec.ts
//
// apply_patch は **利用者のファイルを作成・更新・削除する**ツール。C0 カバレッジが
// 16.6%（368 行中 307 行が未実行）で、失敗系も削除系も一度も試されていなかった。
//
// ここで守るのは「承認されない限りファイルに触らない」「不正な入力で壊さない」こと。
// 特に Delete File は取り返しがつかないので、承認前に unlink しないことを固定する。

import path from "path"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { DEFAULT_WRITE_DELAY_MS } from "@openai-agent/types"

import { ApplyPatchTool } from "../ApplyPatchTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(async () => "old\n"),
		unlink: vi.fn(async () => {}),
		mkdir: vi.fn(async () => {}),
		writeFile: vi.fn(async () => {}),
	},
}))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn(async () => true) }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: vi.fn(() => false) }))
vi.mock("../apply-patch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../apply-patch")>()),
	parsePatch: vi.fn(),
}))

import fs from "fs/promises"
import { fileExistsAtPath } from "../../../utils/fs"
import { parsePatch as realParsePatch } from "../apply-patch"

const mockedUnlink = vi.mocked(fs.unlink)
const mockedFileExists = vi.mocked(fileExistsAtPath)

function makeHost(opts: { accessAllowed?: boolean; writeProtected?: boolean; focusDisruption?: boolean } = {}) {
	const diffViewProvider = {
		editType: "",
		originalContent: undefined as string | undefined,
		open: vi.fn(async () => {}),
		update: vi.fn(async () => {}),
		scrollToFirstDiff: vi.fn(),
		saveChanges: vi.fn(async () => {}),
		saveDirectly: vi.fn(async (..._a: unknown[]) => {}),
		revertChanges: vi.fn(async () => {}),
		reset: vi.fn(async () => {}),
		pushToolWriteResult: vi.fn(async () => "written"),
	}

	const host = {
		cwd: path.join(path.sep, "repo"),
		didEditFile: false,
		mistakeTracker: { count: 0, applyDiffMisses: new Map<string, number>() },
		diffViewProvider,
		rooIgnoreController: { validateAccess: vi.fn(() => opts.accessAllowed ?? true) },
		rooProtectedController: { isWriteProtected: vi.fn(() => opts.writeProtected ?? false) },
		fileContextTracker: { trackFileContext: vi.fn(async () => {}) },
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		providerRef: {
			deref: () => ({
				getState: async () => ({
					experiments: opts.focusDisruption ? { preventFocusDisruption: true } : {},
				}),
			}),
		},
		say: vi.fn(async () => {}),
		ask: vi.fn(async () => {}),
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		processQueuedMessages: vi.fn(),
	}

	return { host, diffViewProvider }
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async (..._a: unknown[]) => approve),
		handleError: vi.fn(async (..._a: unknown[]) => {}),
		pushToolResult: vi.fn((..._a: unknown[]) => {}),
		removeClosingTag: vi.fn((_t: string, v?: string) => v ?? ""),
		toolDescription: vi.fn(() => "apply_patch"),
	}
}

const ADD_PATCH = `*** Begin Patch
*** Add File: new.ts
+export const a = 1
*** End Patch`

const DELETE_PATCH = `*** Begin Patch
*** Delete File: gone.ts
*** End Patch`

const UPDATE_PATCH = `*** Begin Patch
*** Update File: a.ts
@@
-old
+new
*** End Patch`

/** ファイルを変更する経路が一切呼ばれていないこと。 */
function expectNoWrite(dvp: ReturnType<typeof makeHost>["diffViewProvider"], label: string) {
	expect(dvp.saveChanges, `${label}: saveChanges`).not.toHaveBeenCalled()
	expect(dvp.saveDirectly, `${label}: saveDirectly`).not.toHaveBeenCalled()
	expect(mockedUnlink, `${label}: unlink`).not.toHaveBeenCalled()
}

const mockedParsePatch = vi.mocked(realParsePatch)

beforeEach(async () => {
	vi.clearAllMocks()
	mockedFileExists.mockResolvedValue(true)
	vi.mocked(fs.readFile).mockResolvedValue("old\n" as never)
	// 既定では本物のパーサに委譲する（個別テストで差し替える）
	const actual = await vi.importActual<typeof import("../apply-patch")>("../apply-patch")
	mockedParsePatch.mockImplementation(actual.parsePatch)
})

describe("ApplyPatchTool - 入力の検証", () => {
	it("patch が無ければ何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: "" } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "patch 欠落")
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:patch")
		expect(host.mistakeTracker.count).toBe(1)
	})

	it("パースできない patch では何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: "これは patch ではない" } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "パース失敗")
		const result = String(cb.pushToolResult.mock.calls[0][0])
		expect(result).toMatch(/Invalid patch format|Failed to parse patch/)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("apply_patch")
	})

	it("操作が 1 つも無い patch では何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: "*** Begin Patch\n*** End Patch" } as never,
			host as never,
			cb as never,
		)

		expectNoWrite(diffViewProvider, "操作なし")
		expect(cb.pushToolResult).toHaveBeenCalledWith("No file operations found in patch.")
	})

	it("agentignore で拒否されたら何も書かない", async () => {
		const { host, diffViewProvider } = makeHost({ accessAllowed: false })
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "ignore 拒否")
		expect(host.say).toHaveBeenCalledWith("agentignore_error", "new.ts")
	})
})

describe("ApplyPatchTool - Add File", () => {
	it("既に存在するファイルには作成しない", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "既存ファイル")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("File already exists")
	})

	it("承認されなければ書かず、差分ビューを巻き戻す", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks(false)

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "未承認")
		expect(diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
		expect(cb.pushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
	})

	it("承認されたら保存し、編集を記録する", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		expect(diffViewProvider.editType).toBe("create")
		// 新規作成なので元の内容は無い
		expect(diffViewProvider.originalContent).toBeUndefined()
		expect(host.didEditFile).toBe(true)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith("new.ts", "agent_edited")
	})

	it("preventFocusDisruption では差分ビューを開かず直接保存する", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost({ focusDisruption: true })
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expect(diffViewProvider.open).not.toHaveBeenCalled()
		expect(diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
	})

	it("preventFocusDisruption で未承認なら巻き戻しも不要", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost({ focusDisruption: true })
		const cb = makeCallbacks(false)

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "focus・未承認")
		expect(diffViewProvider.revertChanges).not.toHaveBeenCalled()
	})
})

describe("ApplyPatchTool - Delete File", () => {
	it("存在しないファイルは削除しない", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: DELETE_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "削除・存在しない")
	})

	it("**承認されるまで unlink しない**", async () => {
		// 削除は取り返しがつかない。承認前に消えていないことを固定する。
		mockedFileExists.mockResolvedValue(true)
		const { host } = makeHost()
		const cb = makeCallbacks(false)

		await new ApplyPatchTool().execute({ patch: DELETE_PATCH } as never, host as never, cb as never)

		expect(mockedUnlink).not.toHaveBeenCalled()
		expect(cb.pushToolResult).toHaveBeenCalledWith("Delete operation was rejected by the user.")
	})

	it("承認されたら削除する", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: DELETE_PATCH } as never, host as never, cb as never)

		expect(mockedUnlink).toHaveBeenCalledTimes(1)
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("Successfully deleted gone.ts")
	})

	it("削除に失敗したらエラーを返す", async () => {
		mockedFileExists.mockResolvedValue(true)
		mockedUnlink.mockRejectedValueOnce(new Error("EACCES"))
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: DELETE_PATCH } as never, host as never, cb as never)

		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("EACCES")
	})
})

describe("ApplyPatchTool - Update File", () => {
	it("存在しないファイルは更新しない", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "更新・存在しない")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("File not found")
	})

	it("承認されなければ書かない", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks(false)

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "更新・未承認")
	})
})

describe("ApplyPatchTool - 書き込み保護", () => {
	it("保護されたファイルはその旨を承認要求に伝える", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host } = makeHost({ writeProtected: true })
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		// askApproval の第 4 引数が isWriteProtected
		expect(cb.askApproval.mock.calls[0][3]).toBe(true)
	})
})

describe("ApplyPatchTool.handlePartial", () => {
	function partialBlock(patch?: string) {
		return { type: "tool_use", name: "apply_patch", params: { patch }, partial: true } as never
	}

	it("ヘッダからパスを取り出して表示する", async () => {
		const { host } = makeHost()
		const tool = new ApplyPatchTool()

		await tool.handlePartial(host as never, partialBlock("*** Begin Patch\n*** Add File: x.ts\n"))
		await tool.handlePartial(host as never, partialBlock("*** Begin Patch\n*** Add File: x.ts\n+a\n"))

		const calls = (host.ask as never as { mock: { calls: string[][] } }).mock.calls
		expect(calls.length).toBeGreaterThan(0)
		expect(JSON.parse(calls[calls.length - 1][1]).path).toContain("x.ts")
	})

	it("行が途中までしか来ていないパスは採用しない", async () => {
		const { host } = makeHost()
		const tool = new ApplyPatchTool()

		// 改行が無い＝行が未完成
		await tool.handlePartial(host as never, partialBlock("*** Begin Patch\n*** Add File: x.t"))

		const calls = (host.ask as never as { mock: { calls: string[][] } }).mock.calls
		if (calls.length > 0) {
			expect(JSON.parse(calls[0][1]).path).not.toContain("x.t")
		}
	})
})

describe("ApplyPatchTool - Update File の保存", () => {
	const UPDATE_REAL = `*** Begin Patch
*** Update File: a.ts
@@
-old
+new
*** End Patch`

	it("承認されたら保存し、編集を記録する", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_REAL } as never, host as never, cb as never)

		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		expect(host.didEditFile).toBe(true)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "agent_edited")
	})

	it("preventFocusDisruption では直接保存する", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost({ focusDisruption: true })
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_REAL } as never, host as never, cb as never)

		expect(diffViewProvider.open).not.toHaveBeenCalled()
		expect(diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
		expect(diffViewProvider.saveChanges).not.toHaveBeenCalled()
	})

	it("変更が無ければ何も書かない", async () => {
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("new\n" as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		const noop = `*** Begin Patch
*** Update File: a.ts
@@
 new
*** End Patch`
		await new ApplyPatchTool().execute({ patch: noop } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "変更なし")
	})
})

describe("ApplyPatchTool - ファイル移動", () => {
	const MOVE_PATCH = `*** Begin Patch
*** Update File: a.ts
*** Move to: b.ts
@@
-old
+new
*** End Patch`

	it("移動先が agentignore で拒否されたら、元ファイルを消さない", async () => {
		// 移動は元ファイルの削除を伴う。拒否時に消えていないことを固定する。
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		host.rooIgnoreController.validateAccess = vi.fn((p: string) => p !== "b.ts") as never
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: MOVE_PATCH } as never, host as never, cb as never)

		expect(mockedUnlink).not.toHaveBeenCalled()
		expect(host.say).toHaveBeenCalledWith("agentignore_error", "b.ts")
		expect(diffViewProvider.reset).toHaveBeenCalled()
	})

	it("承認されなければ元ファイルを消さない", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host } = makeHost()
		const cb = makeCallbacks(false)

		await new ApplyPatchTool().execute({ patch: MOVE_PATCH } as never, host as never, cb as never)

		expect(mockedUnlink).not.toHaveBeenCalled()
	})

	it("承認されたら移動先へ書いてから元を消し、移動先を追跡する", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: MOVE_PATCH } as never, host as never, cb as never)

		// 書いてから消す（逆順だと失敗時に内容が消える）
		expect(vi.mocked(fs.writeFile)).toHaveBeenCalled()
		expect(mockedUnlink).toHaveBeenCalledTimes(1)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith("b.ts", "agent_edited")
	})

	it("元ファイルの削除に失敗しても処理は完走する", async () => {
		mockedFileExists.mockResolvedValue(true)
		mockedUnlink.mockRejectedValueOnce(new Error("EACCES"))
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: MOVE_PATCH } as never, host as never, cb as never)

		// 移動先は書けているので、タスクとしては成功扱い
		expect(host.didEditFile).toBe(true)
	})
})

describe("ApplyPatchTool - 失敗経路の握りつぶし防止", () => {
	it("hunk の処理に失敗したら何も書かず、原因を返す", async () => {
		// 対象ファイルが読めない＝processAllHunks が投げる
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT") as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "hunk 処理失敗")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("Failed to process patch")
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("apply_patch")
	})

	it("hunk の処理が Error 以外で失敗しても理由を返す", async () => {
		// readFile の失敗はそのまま processAllHunks から伝播する。VS Code の
		// FileSystemError や外部ライブラリ由来の拒否値は Error とは限らないので、
		// String(error) 側でも原因が利用者に届くことを固定する。
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockRejectedValue("EIO: 文字列で投げられた読み取り失敗" as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "hunk 処理・文字列 throw")
		const result = String(cb.pushToolResult.mock.calls[0][0])
		expect(result).toContain("Failed to process patch")
		expect(result).toContain("EIO: 文字列で投げられた読み取り失敗")
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("apply_patch")
	})

	it("保存中に例外が出たら handleError に渡し、差分ビューを片付ける", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		diffViewProvider.saveChanges = vi.fn(async () => {
			throw new Error("disk full")
		}) as never
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expect(cb.handleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
		expect(diffViewProvider.reset).toHaveBeenCalled()
	})

	it("成功したらミスカウントを戻し、利用を記録する", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host } = makeHost()
		host.mistakeTracker.count = 3
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expect(host.mistakeTracker.count).toBe(0)
		expect(host.tokenUsageTracker.recordToolUsage).toHaveBeenCalledWith("apply_patch")
	})
})

describe("ApplyPatchTool - 移動時の preventFocusDisruption", () => {
	const MOVE_PATCH2 = `*** Begin Patch
*** Update File: a.ts
*** Move to: b.ts
@@
-old
+new
*** End Patch`

	it("直接保存を使い、元ファイルは消す", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost({ focusDisruption: true })
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: MOVE_PATCH2 } as never, host as never, cb as never)

		expect(diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
		expect(mockedUnlink).toHaveBeenCalledTimes(1)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith("b.ts", "agent_edited")
	})
})

describe("ApplyPatchTool.handlePartial - パス抽出", () => {
	it("patch が無くてもワークスペース名で表示を出す（UI を空にしない）", async () => {
		const { host } = makeHost()
		const tool = new ApplyPatchTool()

		await tool.handlePartial(
			host as never,
			{
				type: "tool_use",
				name: "apply_patch",
				params: {},
				partial: true,
			} as never,
		)

		const payload = JSON.parse((host.ask as never as { mock: { calls: string[][] } }).mock.calls[0][1])
		expect(payload.path).toBe("repo")
		expect(payload.diff).toBe("Parsing patch...")
	})

	it("Delete File / Update File のヘッダからも取り出す", async () => {
		for (const marker of ["*** Delete File: ", "*** Update File: "]) {
			const { host } = makeHost()
			const tool = new ApplyPatchTool()
			const patch = `*** Begin Patch\n${marker}z.ts\n`

			await tool.handlePartial(
				host as never,
				{
					type: "tool_use",
					name: "apply_patch",
					params: { patch },
					partial: true,
				} as never,
			)
			await tool.handlePartial(
				host as never,
				{
					type: "tool_use",
					name: "apply_patch",
					params: { patch: patch + "x\n" },
					partial: true,
				} as never,
			)

			const calls = (host.ask as never as { mock: { calls: string[][] } }).mock.calls
			expect(calls.length, marker).toBeGreaterThan(0)
			expect(JSON.parse(calls[calls.length - 1][1]).path, marker).toContain("z.ts")
		}
	})
})

describe("ApplyPatchTool - 移動先の安全確認", () => {
	const MOVE = `*** Begin Patch
*** Update File: a.ts
*** Move to: b.ts
@@
-old
+new
*** End Patch`

	it("移動先が書き込み保護なら、元ファイルを消さない", async () => {
		// ここが抜けると保護対象を上書きできてしまう
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		host.rooProtectedController.isWriteProtected = vi.fn((p: string) => p === "b.ts") as never
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: MOVE } as never, host as never, cb as never)

		expect(mockedUnlink).not.toHaveBeenCalled()
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("write-protected path")
		expect(diffViewProvider.reset).toHaveBeenCalled()
	})

	it("移動先がワークスペース外なら、元ファイルを消さない", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()
		const { isPathOutsideWorkspace } = await import("../../../utils/pathUtils")
		vi.mocked(isPathOutsideWorkspace).mockImplementation((p: string) => p.includes("b.ts"))

		await new ApplyPatchTool().execute({ patch: MOVE } as never, host as never, cb as never)

		expect(mockedUnlink).not.toHaveBeenCalled()
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("outside workspace")
		expect(diffViewProvider.reset).toHaveBeenCalled()

		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
	})

	it("ParseError 以外の例外でも patch 解析失敗として扱う", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		// null 文字など、パーサが ParseError 以外を投げうる入力
		await new ApplyPatchTool().execute(
			{ patch: "*** Begin Patch\n*** Update File:\n" } as never,
			host as never,
			cb as never,
		)

		expectNoWrite(diffViewProvider, "解析失敗")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toMatch(/patch/i)
	})
})

describe("ApplyPatchTool - パーサが ParseError 以外を投げた場合", () => {
	it("汎用エラーとして扱い、何も書かない", async () => {
		// ParseError なら "Invalid patch format"、それ以外は "Failed to parse patch"。
		// 後者はパーサの想定外バグを表すので、握りつぶさず利用者に見せる必要がある。
		mockedParsePatch.mockImplementation(() => {
			throw new TypeError("Cannot read properties of undefined")
		})
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "ParseError 以外")
		const result = String(cb.pushToolResult.mock.calls[0][0])
		expect(result).toContain("Failed to parse patch")
		expect(result).toContain("Cannot read properties of undefined")
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("apply_patch")
	})

	it("文字列を throw されても落ちない", async () => {
		mockedParsePatch.mockImplementation(() => {
			throw "文字列例外"
		})
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "文字列 throw")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("文字列例外")
	})
})

describe("ApplyPatchTool - 内容が空になる編集", () => {
	// .gitkeep のような「中身の無いファイル」を作る patch は正当。
	// newContent が "" でも承認要求と保存まで通ることを固定する。
	const EMPTY_ADD = `*** Begin Patch
*** Add File: .gitkeep
*** End Patch`

	it("+ 行が無い Add File でも空ファイルとして作成する", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: EMPTY_ADD } as never, host as never, cb as never)

		// 空の内容で差分ビューを更新し、保存まで到達する
		expect(diffViewProvider.update).toHaveBeenCalledWith("", true)
		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith(".gitkeep", "agent_edited")

		// 差分が空なので統計は出せない＝キーごと落とす（0 件と誤表示しない）
		const payload = JSON.parse(String(cb.askApproval.mock.calls[0][1]))
		expect(payload.diff).toBe("")
		expect(payload.diffStats).toBeUndefined()
	})

	it("空ファイルへの追記でも更新できる", async () => {
		// 既存ファイルが 0 バイトのとき originalContent は "" になる
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("" as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		const appendToEmpty = `*** Begin Patch
*** Update File: a.ts
@@
+added
*** End Patch`
		await new ApplyPatchTool().execute({ patch: appendToEmpty } as never, host as never, cb as never)

		expect(diffViewProvider.originalContent).toBe("")
		expect(diffViewProvider.update).toHaveBeenCalledWith("added\n", true)
		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
	})

	it("差分統計が算出できなくても更新は続行する", async () => {
		// 末尾改行の無いファイル（よくある）を編集すると、差分に
		// "\ No newline at end of file" が入る。sanitizeUnifiedDiff がこの行を
		// 削るため hunk の行数が合わなくなり、computeDiffStats は null を返す。
		// 統計が出せないだけで編集そのものを止めてはいけない。
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("old" as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expect(diffViewProvider.update).toHaveBeenCalledWith("new\n", true)
		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		// null をそのまま載せると UI 側が 0 件と誤表示するので、キーごと落とす
		const payload = JSON.parse(String(cb.askApproval.mock.calls[0][1]))
		expect(payload.diffStats).toBeUndefined()
		expect(Object.keys(payload)).not.toContain("diffStats")
	})

	it("全行を削除して空になる更新でも保存する", async () => {
		// 残り 1 行を消すと newContent は "" になる。ここで falsy 扱いされて
		// 元の内容が書き戻されると、利用者の意図（空にする）が失われる。
		mockedFileExists.mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue("old\n" as never)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		const removeAll = `*** Begin Patch
*** Update File: a.ts
@@
-old
*** End Patch`
		await new ApplyPatchTool().execute({ patch: removeAll } as never, host as never, cb as never)

		expect(diffViewProvider.update).toHaveBeenCalledWith("", true)
		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		expect(host.didEditFile).toBe(true)
	})
})

describe("ApplyPatchTool - provider の状態が取れない場合", () => {
	/** webview が破棄された後など、provider 参照が切れている状況。 */
	function dropProvider(host: ReturnType<typeof makeHost>["host"]) {
		host.providerRef.deref = (() => undefined) as never
	}

	it("Add File: provider が無くても既定設定で保存する", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		dropProvider(host)
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: ADD_PATCH } as never, host as never, cb as never)

		// 実験フラグが取れない＝preventFocusDisruption は無効として扱う
		expect(diffViewProvider.open).toHaveBeenCalledTimes(1)
		expect(diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		// diagnostics は既定 true、書き込み遅延は既定値
		expect(diffViewProvider.saveChanges).toHaveBeenCalledWith(true, DEFAULT_WRITE_DELAY_MS)
	})

	it("Update File: provider が無くても既定設定で保存する", async () => {
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		dropProvider(host)
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expect(diffViewProvider.open).toHaveBeenCalledTimes(1)
		expect(diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(diffViewProvider.saveChanges).toHaveBeenCalledWith(true, DEFAULT_WRITE_DELAY_MS)
	})

	it("設定が返ってきたらその値を保存に渡す", async () => {
		// 既定値で上書きしてしまうと、利用者の diagnostics/遅延設定が無視される
		mockedFileExists.mockResolvedValue(true)
		const { host, diffViewProvider } = makeHost()
		host.providerRef.deref = (() => ({
			getState: async () => ({ diagnosticsEnabled: false, writeDelayMs: 1234, experiments: {} }),
		})) as never
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: UPDATE_PATCH } as never, host as never, cb as never)

		expect(diffViewProvider.saveChanges).toHaveBeenCalledWith(false, 1234)
	})
})

describe("ApplyPatchTool - Delete File の失敗", () => {
	it("Error 以外で失敗しても理由を利用者に返す", async () => {
		// unlink の拒否値は必ずしも Error ではない（テスト差し替えや
		// ネイティブ層由来の値が文字列で来ることがある）
		mockedFileExists.mockResolvedValue(true)
		mockedUnlink.mockRejectedValueOnce("EPERM: 文字列で投げられた削除失敗")
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyPatchTool().execute({ patch: DELETE_PATCH } as never, host as never, cb as never)

		expect(host.say).toHaveBeenCalledWith("error", expect.stringContaining("EPERM: 文字列で投げられた削除失敗"))
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("EPERM: 文字列で投げられた削除失敗")
		// 失敗したのだから成功扱いにしない
		expect(host.didEditFile).toBe(false)
	})
})

describe("ApplyPatchTool.handlePartial - 表示の劣化防止", () => {
	function partial(patch?: string) {
		return { type: "tool_use", name: "apply_patch", params: { patch }, partial: true } as never
	}

	function lastAskPayload(host: ReturnType<typeof makeHost>["host"]) {
		const calls = (host.ask as never as { mock: { calls: string[][] } }).mock.calls
		expect(calls.length).toBeGreaterThan(0)
		return JSON.parse(calls[calls.length - 1][1])
	}

	it("cwd がルートでも表示パスは 'workspace' になる", async () => {
		// ワークスペースを開かずルートで起動した場合、basename は空文字になる
		const { host } = makeHost()
		host.cwd = path.sep

		await new ApplyPatchTool().handlePartial(host as never, partial(undefined))

		expect(lastAskPayload(host).path).toBe("workspace")
	})

	it("ワークスペース直下そのものを指すパスでも表示を空にしない", async () => {
		// 生成途中の patch は '.' のような無意味なパスを出しうる。
		// このとき getReadablePath は空文字を返すので、UI が無題にならないこと。
		const { host } = makeHost()
		host.cwd = path.sep

		await new ApplyPatchTool().handlePartial(host as never, partial("*** Begin Patch\n*** Add File: .\n"))

		expect(lastAskPayload(host).path).toBe("workspace")
	})

	it("6 行以上の patch はプレビューを 5 行で打ち切る", async () => {
		// ストリーミング中の patch 全文を出すと UI が溢れる
		const { host } = makeHost()
		const longPatch = ["*** Begin Patch", "*** Add File: big.ts", "+1", "+2", "+3", "+4", "+5", ""].join("\n")

		await new ApplyPatchTool().handlePartial(host as never, partial(longPatch))

		const diff: string = lastAskPayload(host).diff
		expect(diff.endsWith("\n...")).toBe(true)
		expect(diff.split("\n").slice(0, 5)).toEqual(longPatch.split("\n").slice(0, 5))
	})

	it("5 行以下の patch は打ち切らない", async () => {
		const { host } = makeHost()
		const shortPatch = "*** Begin Patch\n*** Add File: small.ts\n+1\n"

		await new ApplyPatchTool().handlePartial(host as never, partial(shortPatch))

		expect(lastAskPayload(host).diff).toBe(shortPatch)
	})
})
