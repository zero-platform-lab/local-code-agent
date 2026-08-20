// npx vitest run core/tools/__tests__/ApplyDiffTool.spec.ts
//
// apply_diff は **利用者のファイルを書き換える**ツール。C0 カバレッジが 7.2%
// （221 行中 205 行が未実行）で、失敗系の分岐が一度も試されていなかった。
//
// ここで守るのは「差分の適用に失敗したとき、ファイルを触らない」こと。
// 承認されなかった / 差分が当たらなかった / ファイルが無い / 保護されている、の
// どの経路でも保存が呼ばれてはいけない。

import path from "path"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { ApplyDiffTool } from "../ApplyDiffTool"

vi.mock("fs/promises", () => ({
	default: { readFile: vi.fn(async () => "original content\n") },
}))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn(async () => true) }))

import fs from "fs/promises"
import { fileExistsAtPath } from "../../../utils/fs"

const mockedReadFile = vi.mocked(fs.readFile)
const mockedFileExists = vi.mocked(fileExistsAtPath)

type DiffResult =
	| { success: true; content: string; failParts?: Array<{ success: boolean; error?: string }> }
	| { success: false; error?: string; details?: unknown; failParts?: Array<{ success: boolean; error?: string }> }

function makeHost(opts: { diffResult?: DiffResult; accessAllowed?: boolean; writeProtected?: boolean } = {}) {
	const diffViewProvider = {
		editType: "",
		originalContent: "",
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
		stream: { didToolFailInCurrentTurn: false },
		api: { getModel: () => ({ id: "gpt-4o" }) },
		diffStrategy: {
			applyDiff: vi.fn(
				async (..._a: unknown[]) => opts.diffResult ?? { success: true, content: "patched content\n" },
			),
		},
		rooIgnoreController: { validateAccess: vi.fn(() => opts.accessAllowed ?? true) },
		rooProtectedController: { isWriteProtected: vi.fn(() => opts.writeProtected ?? false) },
		diffViewProvider,
		fileContextTracker: { trackFileContext: vi.fn(async () => {}) },
		tokenUsageTracker: { recordToolError: vi.fn() },
		providerRef: { deref: () => ({ getState: async () => ({}) }) },
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
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn((..._a: unknown[]) => {}),
		removeClosingTag: vi.fn((_t: string, v?: string) => v ?? ""),
		toolDescription: vi.fn(() => "apply_diff"),
	}
}

const VALID_DIFF = "<<<<<<< SEARCH\noriginal content\n=======\npatched content\n>>>>>>> REPLACE"

/** ファイルへ書き込む経路が一切呼ばれていないこと。 */
function expectNoWrite(dvp: ReturnType<typeof makeHost>["diffViewProvider"], label: string) {
	expect(dvp.saveChanges, `${label}: saveChanges が呼ばれた`).not.toHaveBeenCalled()
	expect(dvp.saveDirectly, `${label}: saveDirectly が呼ばれた`).not.toHaveBeenCalled()
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedReadFile.mockResolvedValue("original content\n" as never)
	mockedFileExists.mockResolvedValue(true)
})

describe("ApplyDiffTool - ファイルを壊さない", () => {
	it("path が無ければ何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "path 欠落")
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:path")
		expect(host.mistakeTracker.count).toBe(1)
	})

	it("diff が無ければ何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: "" } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "diff 欠落")
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:diff")
	})

	it("agentignore で拒否されたら何も書かない", async () => {
		const { host, diffViewProvider } = makeHost({ accessAllowed: false })
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "secret.env", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "ignore 拒否")
		expect(host.say).toHaveBeenCalledWith("agentignore_error", "secret.env")
		// 読み込みもしない
		expect(mockedReadFile).not.toHaveBeenCalled()
	})

	it("ファイルが存在しなければ何も書かない", async () => {
		mockedFileExists.mockResolvedValue(false)
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "nope.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "ファイル無し")
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(cb.pushToolResult.mock.calls[0][0]).toContain("File does not exist")
	})

	it("差分が当たらなければ何も書かない", async () => {
		const { host, diffViewProvider } = makeHost({
			diffResult: { success: false, error: "no match", details: { line: 3 } },
		})
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "差分不一致")
		const result = cb.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("Unable to apply diff")
		expect(result).toContain("no match")
		// details も渡して原因を追えるようにする
		expect(result).toContain('"line": 3')
	})

	it("diffStrategy が無ければ何も書かない", async () => {
		const { host, diffViewProvider } = makeHost()
		;(host as { diffStrategy?: unknown }).diffStrategy = undefined
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "戦略無し")
		expect(cb.pushToolResult.mock.calls[0][0]).toContain("No diff strategy available")
	})

	it("承認されなければ書かず、diff ビューの変更を巻き戻す", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks(false)

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "未承認")
		expect(diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
	})

	it("適用中に例外が出たら握りつぶさず、diff ビューを片付ける", async () => {
		const { host, diffViewProvider } = makeHost()
		host.diffStrategy.applyDiff = vi.fn(async () => {
			throw new Error("boom")
		}) as never
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "例外")
		expect(cb.handleError).toHaveBeenCalledWith("applying diff", expect.any(Error))
		expect(diffViewProvider.reset).toHaveBeenCalled()
	})
})

describe("ApplyDiffTool - 成功したとき", () => {
	it("承認されたら保存し、編集を記録する", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		expect(host.didEditFile).toBe(true)
		expect(host.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "agent_edited")
		// 成功したらミスカウントは戻す
		expect(host.mistakeTracker.count).toBe(0)
		expect(host.mistakeTracker.applyDiffMisses.has("a.ts")).toBe(false)
	})

	it("一部だけ失敗したら、その旨を結果に含める", async () => {
		const { host } = makeHost({
			diffResult: {
				success: true,
				content: "patched content\n",
				failParts: [{ success: false, error: "block 2 not found" }],
			},
		})
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		const result = cb.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("unable to apply all diff parts")
		expect(result).toContain("read_file")
	})

	it("SEARCH ブロックが 1 つだけなら、まとめて編集するよう促す", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expect(cb.pushToolResult.mock.calls[0][0]).toContain("<notice>")
	})

	it("SEARCH ブロックが複数なら促さない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()
		const twoBlocks = `${VALID_DIFF}\n${VALID_DIFF}`

		await new ApplyDiffTool().execute({ path: "a.ts", diff: twoBlocks } as never, host as never, cb as never)

		expect(cb.pushToolResult.mock.calls[0][0]).not.toContain("<notice>")
	})

	it("書き込み保護されたファイルは、その旨を承認要求に伝える", async () => {
		const { host } = makeHost({ writeProtected: true })
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute(
			{ path: ".agentignore", diff: VALID_DIFF } as never,
			host as never,
			cb as never,
		)

		// askApproval の第 4 引数が isWriteProtected
		expect(cb.askApproval.mock.calls[0][3]).toBe(true)
	})
})

describe("ApplyDiffTool - 失敗の再発カウント", () => {
	it("同じファイルで 2 回失敗したら diff_error を出す", async () => {
		const { host } = makeHost({ diffResult: { success: false, error: "no match" } })
		const cb = makeCallbacks()
		const tool = new ApplyDiffTool()

		await tool.execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)
		expect(host.say).not.toHaveBeenCalledWith("diff_error", expect.anything())

		await tool.execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)
		expect(host.say).toHaveBeenCalledWith("diff_error", expect.stringContaining("no match"))
		expect(host.mistakeTracker.applyDiffMisses.get("a.ts")).toBe(2)
	})

	it("別ファイルの失敗はカウントを共有しない", async () => {
		const { host } = makeHost({ diffResult: { success: false, error: "no match" } })
		const cb = makeCallbacks()
		const tool = new ApplyDiffTool()

		await tool.execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)
		await tool.execute({ path: "b.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expect(host.mistakeTracker.applyDiffMisses.get("a.ts")).toBe(1)
		expect(host.mistakeTracker.applyDiffMisses.get("b.ts")).toBe(1)
		expect(host.say).not.toHaveBeenCalledWith("diff_error", expect.anything())
	})
})

describe("ApplyDiffTool - preventFocusDisruption 経路", () => {
	function makeFocusHost(approve = true) {
		const { host, diffViewProvider } = makeHost()
		host.providerRef = {
			deref: () => ({
				getState: async () => ({
					experiments: { preventFocusDisruption: true },
					diagnosticsEnabled: false,
					writeDelayMs: 42,
				}),
			}),
		} as never
		return { host, diffViewProvider, cb: makeCallbacks(approve) }
	}

	it("diff ビューを開かず、直接保存する", async () => {
		const { host, diffViewProvider, cb } = makeFocusHost()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		// エディタを開かない（フォーカスを奪わないのが目的）
		expect(diffViewProvider.open).not.toHaveBeenCalled()
		expect(diffViewProvider.update).not.toHaveBeenCalled()
		expect(diffViewProvider.saveChanges).not.toHaveBeenCalled()

		expect(diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
		// 元の内容を退避してから書く（巻き戻せるように）
		expect(diffViewProvider.originalContent).toBe("original content\n")
		expect(diffViewProvider.editType).toBe("modify")
	})

	it("設定した diagnostics / writeDelay を保存に渡す", async () => {
		const { host, diffViewProvider, cb } = makeFocusHost()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		const args = diffViewProvider.saveDirectly.mock.calls[0]
		expect(args[0]).toBe("a.ts")
		expect(args[1]).toBe("patched content\n")
		expect(args[3]).toBe(false) // diagnosticsEnabled
		expect(args[4]).toBe(42) // writeDelayMs
	})

	it("承認されなければ直接保存もしない", async () => {
		const { host, diffViewProvider, cb } = makeFocusHost(false)

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "focus 経路・未承認")
		// この経路では diff ビューを開いていないので巻き戻しも不要
		expect(diffViewProvider.revertChanges).not.toHaveBeenCalled()
	})
})

describe("ApplyDiffTool.handlePartial", () => {
	function partialBlock(params: { path?: string; diff?: string }) {
		return { type: "tool_use", name: "apply_diff", params, partial: true } as never
	}

	it("パスが安定するまで UI を出さない", async () => {
		const { host } = makeHost()
		const tool = new ApplyDiffTool()

		// 1 回目は安定判定が立たない
		await tool.handlePartial(host as never, partialBlock({ path: "a.t" }))
		expect(host.ask).not.toHaveBeenCalled()
	})

	it("同じパスが続けば ask を出す", async () => {
		const { host } = makeHost()
		host.diffStrategy = { applyDiff: vi.fn() } as never // getProgressStatus 無し
		const tool = new ApplyDiffTool()

		await tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "part" }))
		await tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "partial" }))

		expect(host.ask).toHaveBeenCalled()
		const payload = JSON.parse((host.ask as never as { mock: { calls: string[][] } }).mock.calls[0][1])
		expect(payload.tool).toBe("appliedDiff")
	})

	it("進捗が空オブジェクトなら ask を出さない", async () => {
		const { host } = makeHost()
		host.diffStrategy = { applyDiff: vi.fn(), getProgressStatus: vi.fn(() => ({})) } as never
		const tool = new ApplyDiffTool()

		await tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "x" }))
		await tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "xy" }))

		expect(host.ask).not.toHaveBeenCalled()
	})

	it("ask が投げても伝播させない（部分更新で落とさない）", async () => {
		const { host } = makeHost()
		host.diffStrategy = { applyDiff: vi.fn() } as never
		host.ask = vi.fn(async () => {
			throw new Error("ask rejected")
		}) as never
		const tool = new ApplyDiffTool()

		await tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "x" }))
		await expect(
			tool.handlePartial(host as never, partialBlock({ path: "a.ts", diff: "xy" })),
		).resolves.toBeUndefined()
	})
})

describe("ApplyDiffTool - 進捗表示つきの diffStrategy", () => {
	it("承認要求に進捗を添える（diff ビュー経路）", async () => {
		const { host } = makeHost()
		const getProgressStatus = vi.fn((..._a: unknown[]) => ({ icon: "check", text: "2/2" }))
		host.diffStrategy = {
			applyDiff: vi.fn(async () => ({ success: true, content: "patched content\n" })),
			getProgressStatus,
		} as never
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		// askApproval の第 3 引数が進捗
		expect(cb.askApproval.mock.calls[0][2]).toEqual({ icon: "check", text: "2/2" })
		// 進捗計算には確定済み（partial:false）のブロックを渡す
		const block = getProgressStatus.mock.calls[0][0] as { partial: boolean; params: { path: string } }
		expect(block.partial).toBe(false)
		expect(block.params.path).toBe("a.ts")
	})

	it("承認要求に進捗を添える（preventFocusDisruption 経路）", async () => {
		const { host } = makeHost()
		host.providerRef = {
			deref: () => ({ getState: async () => ({ experiments: { preventFocusDisruption: true } }) }),
		} as never
		host.diffStrategy = {
			applyDiff: vi.fn(async () => ({ success: true, content: "patched content\n" })),
			getProgressStatus: vi.fn(() => ({ icon: "check", text: "1/1" })),
		} as never
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expect(cb.askApproval.mock.calls[0][2]).toEqual({ icon: "check", text: "1/1" })
	})
})

describe("ApplyDiffTool - 部分失敗を含む適用エラー", () => {
	it("failParts があればその内訳を返し、ファイルは触らない", async () => {
		const { host, diffViewProvider } = makeHost({
			diffResult: {
				success: false,
				failParts: [
					{ success: true },
					{ success: false, error: "block 2 not found", details: { line: 12 } } as never,
				],
			},
		})
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expectNoWrite(diffViewProvider, "部分失敗")
		const result = cb.pushToolResult.mock.calls[0][0] as string
		// 成功した part は報告に混ぜない
		expect(result).toContain("block 2 not found")
		expect(result).toContain('"line": 12')
		expect(result).toContain("<error_details>")
	})

	it("failParts に details が無くてもエラー本文は出す", async () => {
		const { host } = makeHost({
			diffResult: { success: false, failParts: [{ success: false, error: "no anchor" }] },
		})
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		const result = cb.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("no anchor")
		expect(result).not.toContain("Details:")
	})
})

describe("ApplyDiffTool - 入力の揺れ", () => {
	it(":start_line: があれば開始行として diffStrategy に渡す", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()
		const diffWithLine = `<<<<<<< SEARCH\n:start_line:42\noriginal content\n=======\npatched\n>>>>>>> REPLACE`

		await new ApplyDiffTool().execute({ path: "a.ts", diff: diffWithLine } as never, host as never, cb as never)

		expect(host.diffStrategy.applyDiff).toHaveBeenCalledWith(expect.any(String), diffWithLine, 42)
	})

	it(":start_line: が無ければ NaN を渡す（戦略側の既定に委ねる）", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		const startLine = host.diffStrategy.applyDiff.mock.calls[0][2] as number
		expect(Number.isNaN(startLine)).toBe(true)
	})

	it("SEARCH マーカーが 1 つも無くても落ちない", async () => {
		const { host, diffViewProvider } = makeHost()
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute(
			{ path: "a.ts", diff: "no markers here" } as never,
			host as never,
			cb as never,
		)

		// 0 ブロックなので単一ブロック警告は出さない
		expect(cb.pushToolResult.mock.calls[0][0]).not.toContain("<notice>")
		expect(diffViewProvider.saveChanges).toHaveBeenCalled()
	})

	it("claude 系モデルでは HTML エンティティを復元しない", async () => {
		const { host } = makeHost()
		host.api = { getModel: () => ({ id: "claude-sonnet-4" }) } as never
		const cb = makeCallbacks()
		const escaped = "<<<<<<< SEARCH\na &amp;&amp; b\n=======\nc\n>>>>>>> REPLACE"

		await new ApplyDiffTool().execute({ path: "a.ts", diff: escaped } as never, host as never, cb as never)

		expect(host.diffStrategy.applyDiff.mock.calls[0][1]).toContain("&amp;&amp;")
	})

	it("claude 系以外では HTML エンティティを復元する", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()
		const escaped = "<<<<<<< SEARCH\na &amp;&amp; b\n=======\nc\n>>>>>>> REPLACE"

		await new ApplyDiffTool().execute({ path: "a.ts", diff: escaped } as never, host as never, cb as never)

		expect(host.diffStrategy.applyDiff.mock.calls[0][1]).toContain("a && b")
	})
})

describe("ApplyDiffTool - 差分統計が取れない場合", () => {
	it("内容が変わらない差分でも保存経路は完走する", async () => {
		// computeDiffStats が空を返す（変更行ゼロ）ケース。undefined に落として渡す
		const { host, diffViewProvider } = makeHost({
			diffResult: { success: true, content: "original content\n" },
		})
		const cb = makeCallbacks()

		await new ApplyDiffTool().execute({ path: "a.ts", diff: VALID_DIFF } as never, host as never, cb as never)

		expect(diffViewProvider.saveChanges).toHaveBeenCalledTimes(1)
		const payload = JSON.parse(cb.askApproval.mock.calls[0][1] as string)
		expect(payload.diffStats).toBeUndefined()
	})
})
