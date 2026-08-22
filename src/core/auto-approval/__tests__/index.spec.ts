// npx vitest run src/core/auto-approval/__tests__/index.spec.ts
//
// `checkAutoApproval` は「ユーザーに確認せず実行してよいか」を決めるゲート。
// ここが誤判定するとコマンド実行・ファイル書き込み・削除が無確認で走るため、
// 「設定が無い / 壊れている / 未知の値」のときは必ず ask（＝ユーザーに聞く）へ倒れることを
// 不変条件として固定する。
import type { ClineAsk, ClineSayTool, McpServer } from "@openai-agent/types"

import { checkAutoApproval, type CheckAutoApprovalResult } from "../index"

type CheckArgs = Parameters<typeof checkAutoApproval>[0]
type AutoApprovalStateInput = NonNullable<CheckArgs["state"]>

/** MCP サーバ一覧のフィクスチャ。`allowed` ツールだけが alwaysAllow。 */
const MCP_SERVERS: McpServer[] = [
	{
		name: "srv",
		config: "{}",
		status: "connected",
		tools: [
			{ name: "allowed", alwaysAllow: true },
			{ name: "notAllowed", alwaysAllow: false },
			{ name: "undefinedFlag" },
		],
	},
]

/**
 * 「全開」設定。個別トグルをすべて true にし、コマンドはワイルドカード許可。
 * autoApprovalEnabled を付けるかどうかだけを変えて fail-safe を確かめるために使う。
 */
const ALL_TOGGLES_ON = {
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: true,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: true,
	alwaysAllowWriteProtected: true,
	alwaysAllowMcp: true,
	alwaysAllowSubtasks: true,
	alwaysAllowExecute: true,
	alwaysAllowFollowupQuestions: true,
	followupAutoApproveTimeoutMs: 1000,
	allowedCommands: ["*"],
	deniedCommands: [],
	mcpServers: MCP_SERVERS,
} satisfies AutoApprovalStateInput

/** autoApprovalEnabled だけ true で、個別トグルは一切設定されていない状態。 */
const ONLY_MASTER_ON: AutoApprovalStateInput = { autoApprovalEnabled: true }

const toolText = (tool: Partial<ClineSayTool> & Pick<ClineSayTool, "tool">): string => JSON.stringify(tool)

const mcpText = (use: { type: string; serverName?: string; toolName?: string; uri?: string }): string =>
	JSON.stringify(use)

/** timeout 判定を型で絞り込みつつ、そうでなければ落とす。 */
const expectTimeout = (result: CheckAutoApprovalResult): Extract<CheckAutoApprovalResult, { decision: "timeout" }> => {
	if (result.decision !== "timeout") {
		throw new Error(`timeout を期待したが ${result.decision} が返った`)
	}
	return result
}

/**
 * 「全開設定なら承認される」要求の一覧。
 * 同じ表を、設定欠落・全トグル off の状態にも通して ask に倒れることを確認する。
 */
const APPROVABLE_REQUESTS: Array<{ name: string; ask: ClineAsk; text?: string; isProtected?: boolean }> = [
	{ name: "読み取り(readFile)", ask: "tool", text: toolText({ tool: "readFile", path: "a.ts" }) },
	{ name: "一覧(listFilesTopLevel)", ask: "tool", text: toolText({ tool: "listFilesTopLevel", path: "." }) },
	{ name: "検索(searchFiles)", ask: "tool", text: toolText({ tool: "searchFiles", regex: "foo" }) },
	{ name: "コードベース検索(codebaseSearch)", ask: "tool", text: toolText({ tool: "codebaseSearch", query: "q" }) },
	{ name: "スラッシュコマンド(runSlashCommand)", ask: "tool", text: toolText({ tool: "runSlashCommand" }) },
	{
		name: "ワークスペース外の読み取り",
		ask: "tool",
		text: toolText({ tool: "readFile", path: "/etc/passwd", isOutsideWorkspace: true }),
	},
	{ name: "新規ファイル作成(newFileCreated)", ask: "tool", text: toolText({ tool: "newFileCreated", path: "a.ts" }) },
	{ name: "既存ファイル編集(editedExistingFile)", ask: "tool", text: toolText({ tool: "editedExistingFile" }) },
	{ name: "差分適用(appliedDiff)", ask: "tool", text: toolText({ tool: "appliedDiff" }) },
	{
		name: "ワークスペース外への書き込み",
		ask: "tool",
		text: toolText({ tool: "newFileCreated", path: "/etc/hosts", isOutsideWorkspace: true }),
	},
	{
		name: "保護ファイルへの書き込み",
		ask: "tool",
		text: toolText({ tool: "editedExistingFile", path: ".agentignore" }),
		isProtected: true,
	},
	{ name: "サブタスク開始(newTask)", ask: "tool", text: toolText({ tool: "newTask" }) },
	{ name: "サブタスク終了(finishTask)", ask: "tool", text: toolText({ tool: "finishTask" }) },
	{ name: "コマンド実行", ask: "command", text: "npm run build" },
	{
		name: "MCP ツール実行",
		ask: "use_mcp_server",
		text: mcpText({ type: "use_mcp_tool", serverName: "srv", toolName: "allowed" }),
	},
	{
		name: "MCP リソース取得",
		ask: "use_mcp_server",
		text: mcpText({ type: "access_mcp_resource", serverName: "srv", uri: "res://x" }),
	},
]

describe("checkAutoApproval", () => {
	describe("表駆動: 全開設定では承認される（比較用のベースライン）", () => {
		it.each(APPROVABLE_REQUESTS)("$name は approve", async ({ ask, text, isProtected }) => {
			const result = await checkAutoApproval({
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
				ask,
				text,
				isProtected,
			})

			expect(result.decision).toBe("approve")
		})
	})

	describe("不変条件1: 設定が無い/壊れている/無効なら自動承認しない", () => {
		const brokenStates: Array<{ name: string; state: CheckArgs["state"] }> = [
			{ name: "state が undefined", state: undefined },
			{ name: "state が null", state: null as unknown as CheckArgs["state"] },
			{ name: "state が空オブジェクト", state: {} },
			{
				name: "autoApprovalEnabled が false（他は全開）",
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: false },
			},
			{ name: "autoApprovalEnabled が未設定（他は全開）", state: { ...ALL_TOGGLES_ON } },
			{
				name: "autoApprovalEnabled が truthy な非 boolean（他は全開）",
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: undefined },
			},
		]

		for (const { name, state } of brokenStates) {
			// 全開設定でも autoApprovalEnabled が立っていなければ 1 件も通してはいけない。
			it.each(APPROVABLE_REQUESTS)(`${name}: $name は ask`, async ({ ask, text, isProtected }) => {
				const result = await checkAutoApproval({ state, ask, text, isProtected })
				expect(result.decision).toBe("ask")
			})
		}

		it("followup も設定が無ければ ask（timeout 自動応答をしない）", async () => {
			const text = JSON.stringify({ question: "?", suggest: [{ answer: "はい" }] })

			expect((await checkAutoApproval({ state: undefined, ask: "followup", text })).decision).toBe("ask")
			expect((await checkAutoApproval({ state: {}, ask: "followup", text })).decision).toBe("ask")
			expect((await checkAutoApproval({ state: { ...ALL_TOGGLES_ON }, ask: "followup", text })).decision).toBe(
				"ask",
			)
		})
	})

	describe("不変条件2: 未知のツール名・未知の ask 種別は自動承認しない", () => {
		// clineAsks に無い値を渡しても、既知の ask に化けたりしないこと。
		it.each(["totally_unknown_ask", "TOOL", "", "__proto__"])("未知の ask 種別 %s は ask", async (ask) => {
			const result = await checkAutoApproval({
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
				ask: ask as ClineAsk,
				text: toolText({ tool: "readFile" }),
			})

			expect(result.decision).toBe("ask")
		})

		it.each(["imageGenerated", "readCommandOutput", "unknownTool", "", "toString"])(
			"未知/未分類のツール %s は全開設定でも ask",
			async (tool) => {
				const result = await checkAutoApproval({
					state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
					ask: "tool",
					text: JSON.stringify({ tool }),
				})

				expect(result.decision).toBe("ask")
			},
		)

		it.each(["totally_unknown_mcp_type", "", "use_mcp_TOOL"])(
			"未知の MCP 種別 %s は全開設定でも ask",
			async (type) => {
				const result = await checkAutoApproval({
					state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
					ask: "use_mcp_server",
					text: mcpText({ type, serverName: "srv", toolName: "allowed" }),
				})

				expect(result.decision).toBe("ask")
			},
		)

		// 承認を伴わない ask 種別（completion_result など）はそもそも承認対象ではない。
		it.each<ClineAsk>([
			"completion_result",
			"api_req_failed",
			"resume_task",
			"resume_completed_task",
			"mistake_limit_reached",
			"auto_approval_max_req_reached",
		])("承認対象外の ask 種別 %s は ask", async (ask) => {
			const result = await checkAutoApproval({
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
				ask,
			})

			expect(result.decision).toBe("ask")
		})
	})

	describe("不変条件3: 個別トグルが off なら親トグルが on でも自動承認しない", () => {
		it.each(APPROVABLE_REQUESTS)(
			"autoApprovalEnabled だけ true（個別トグル未設定）では $name は ask",
			async ({ ask, text, isProtected }) => {
				const result = await checkAutoApproval({ state: ONLY_MASTER_ON, ask, text, isProtected })
				expect(result.decision).toBe("ask")
			},
		)

		// 「他カテゴリのトグルが on」だけでは自分のカテゴリは通らない（漏れ承認の防止）。
		const crossTalk: Array<{ name: string; state: AutoApprovalStateInput; ask: ClineAsk; text: string }> = [
			{
				name: "write だけ on で readFile",
				state: { autoApprovalEnabled: true, alwaysAllowWrite: true },
				ask: "tool",
				text: toolText({ tool: "readFile" }),
			},
			{
				name: "readOnly だけ on で newFileCreated",
				state: { autoApprovalEnabled: true, alwaysAllowReadOnly: true },
				ask: "tool",
				text: toolText({ tool: "newFileCreated" }),
			},
			{
				name: "mcp だけ on でコマンド実行",
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true, allowedCommands: ["*"] },
				ask: "command",
				text: "rm -rf build",
			},
			{
				name: "execute だけ on で MCP ツール",
				state: { autoApprovalEnabled: true, alwaysAllowExecute: true, mcpServers: MCP_SERVERS },
				ask: "use_mcp_server",
				text: mcpText({ type: "use_mcp_tool", serverName: "srv", toolName: "allowed" }),
			},
		]

		it.each(crossTalk)("$name は ask", async ({ state, ask, text }) => {
			expect((await checkAutoApproval({ state, ask, text })).decision).toBe("ask")
		})

		// サブオプションだけ on でも親トグルが off なら通らない。
		it("alwaysAllowReadOnlyOutsideWorkspace だけ on では readFile は ask", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowReadOnlyOutsideWorkspace: true },
				ask: "tool",
				text: toolText({ tool: "readFile", isOutsideWorkspace: true }),
			})

			expect(result.decision).toBe("ask")
		})

		it("alwaysAllowWriteOutsideWorkspace / WriteProtected だけ on では書き込みは ask", async () => {
			const state: AutoApprovalStateInput = {
				autoApprovalEnabled: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
			}

			expect(
				(await checkAutoApproval({ state, ask: "tool", text: toolText({ tool: "appliedDiff" }) })).decision,
			).toBe("ask")
		})

		// boolean 以外の truthy 値を渡しても `=== true` の厳密比較で弾かれること。
		it.each([1, "true", {}, []])("トグルが真偽値でない値 %o のときは ask", async (truthy) => {
			const state = {
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: truthy,
			} as unknown as AutoApprovalStateInput

			const result = await checkAutoApproval({ state, ask: "tool", text: toolText({ tool: "readFile" }) })
			expect(result.decision).toBe("ask")
		})
	})

	describe("非ブロッキング ask（command_output）", () => {
		// 実装は isNonBlockingAsk を state 検査より前に評価するため、設定に関係なく approve になる。
		// これは「コマンド出力の表示を続けるか」という UI 上のフロー制御であり、実行許可ではない。
		it.each([undefined, {}, { autoApprovalEnabled: false }] as Array<CheckArgs["state"]>)(
			"state が %o でも command_output は approve（承認ゲートではないため）",
			async (state) => {
				const result = await checkAutoApproval({ state, ask: "command_output", text: "" })
				expect(result.decision).toBe("approve")
			},
		)
	})

	describe("followup（提案の自動選択）", () => {
		const suggestText = JSON.stringify({ question: "どちら?", suggest: [{ answer: "はい" }, { answer: "いいえ" }] })

		it("トグル on + 提案あり + timeout>0 なら timeout 判定を返し、fn は先頭の提案を返す", async () => {
			const result = expectTimeout(
				await checkAutoApproval({
					state: {
						autoApprovalEnabled: true,
						alwaysAllowFollowupQuestions: true,
						followupAutoApproveTimeoutMs: 1500,
					},
					ask: "followup",
					text: suggestText,
				}),
			)

			expect(result.timeout).toBe(1500)
			expect(result.fn()).toEqual({ askResponse: "messageResponse", text: "はい" })
		})

		it("トグル off なら timeout にならず ask", async () => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowFollowupQuestions: false,
					followupAutoApproveTimeoutMs: 1500,
				},
				ask: "followup",
				text: suggestText,
			})

			expect(result.decision).toBe("ask")
		})

		const followupAskCases: Array<{ name: string; text?: string; timeout?: unknown }> = [
			{ name: "text が undefined（提案なし）", text: undefined, timeout: 1500 },
			{ name: "suggest が空配列", text: JSON.stringify({ suggest: [] }), timeout: 1500 },
			{ name: "suggest キー自体が無い", text: JSON.stringify({ question: "?" }), timeout: 1500 },
			{ name: "timeout が未設定", text: suggestText, timeout: undefined },
			{ name: "timeout が 0", text: suggestText, timeout: 0 },
			{ name: "timeout が負値", text: suggestText, timeout: -1 },
			{ name: "timeout が数値でない文字列", text: suggestText, timeout: "1500" },
			{ name: "JSON として壊れている", text: "{壊れた JSON", timeout: 1500 },
			{ name: "JSON が null", text: "null", timeout: 1500 },
		]

		it.each(followupAskCases)("$name のときは ask", async ({ text, timeout }) => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: timeout as number | undefined,
				},
				ask: "followup",
				text,
			})

			expect(result.decision).toBe("ask")
		})
	})

	describe("use_mcp_server", () => {
		const mcpOn: AutoApprovalStateInput = {
			autoApprovalEnabled: true,
			alwaysAllowMcp: true,
			mcpServers: MCP_SERVERS,
		}

		it("text が無ければ ask", async () => {
			expect((await checkAutoApproval({ state: mcpOn, ask: "use_mcp_server", text: undefined })).decision).toBe(
				"ask",
			)
			expect((await checkAutoApproval({ state: mcpOn, ask: "use_mcp_server", text: "" })).decision).toBe("ask")
		})

		it("JSON が壊れていれば ask", async () => {
			const result = await checkAutoApproval({ state: mcpOn, ask: "use_mcp_server", text: "{壊れた" })
			expect(result.decision).toBe("ask")
		})

		const toolCases: Array<{ name: string; toolName?: string; serverName?: string; expected: string }> = [
			{ name: "alwaysAllow のツール", serverName: "srv", toolName: "allowed", expected: "approve" },
			{ name: "alwaysAllow が false のツール", serverName: "srv", toolName: "notAllowed", expected: "ask" },
			{ name: "alwaysAllow 未設定のツール", serverName: "srv", toolName: "undefinedFlag", expected: "ask" },
			{ name: "存在しないツール名", serverName: "srv", toolName: "ghost", expected: "ask" },
			{ name: "存在しないサーバ名", serverName: "other", toolName: "allowed", expected: "ask" },
			{ name: "toolName が無い", serverName: "srv", toolName: undefined, expected: "ask" },
		]

		it.each(toolCases)("use_mcp_tool: $name は $expected", async ({ serverName, toolName, expected }) => {
			const result = await checkAutoApproval({
				state: mcpOn,
				ask: "use_mcp_server",
				text: mcpText({ type: "use_mcp_tool", serverName, toolName }),
			})

			expect(result.decision).toBe(expected)
		})

		it("mcpServers が未設定なら alwaysAllowMcp が on でも use_mcp_tool は ask", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true },
				ask: "use_mcp_server",
				text: mcpText({ type: "use_mcp_tool", serverName: "srv", toolName: "allowed" }),
			})

			expect(result.decision).toBe("ask")
		})

		it("alwaysAllowMcp が off なら alwaysAllow 済みツールでも ask", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: false, mcpServers: MCP_SERVERS },
				ask: "use_mcp_server",
				text: mcpText({ type: "use_mcp_tool", serverName: "srv", toolName: "allowed" }),
			})

			expect(result.decision).toBe("ask")
		})

		it("access_mcp_resource は alwaysAllowMcp のみで approve（サーバ個別の許可を見ない）", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: true },
				ask: "use_mcp_server",
				text: mcpText({ type: "access_mcp_resource", serverName: "未知のサーバ", uri: "res://x" }),
			})

			expect(result.decision).toBe("approve")
		})

		it("access_mcp_resource も alwaysAllowMcp が off なら ask", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowMcp: false },
				ask: "use_mcp_server",
				text: mcpText({ type: "access_mcp_resource", serverName: "srv", uri: "res://x" }),
			})

			expect(result.decision).toBe("ask")
		})
	})

	describe("command（コマンド実行）", () => {
		it("text が無ければ ask", async () => {
			const state: AutoApprovalStateInput = {
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["*"],
			}

			expect((await checkAutoApproval({ state, ask: "command", text: undefined })).decision).toBe("ask")
			expect((await checkAutoApproval({ state, ask: "command", text: "" })).decision).toBe("ask")
		})

		it("alwaysAllowExecute が off なら allowlist に載っていても ask", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowExecute: false, allowedCommands: ["npm"] },
				ask: "command",
				text: "npm run build",
			})

			expect(result.decision).toBe("ask")
		})

		it("allowedCommands が未設定なら approve しない（allowlist 無し = 承認しない）", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowExecute: true },
				ask: "command",
				text: "npm run build",
			})

			expect(result.decision).toBe("ask")
		})

		const commandCases: Array<{
			name: string
			text: string
			allowed?: string[]
			denied?: string[]
			expected: string
		}> = [
			{ name: "allowlist 前方一致", text: "npm run build", allowed: ["npm"], expected: "approve" },
			{ name: "allowlist に無い", text: "curl http://x", allowed: ["npm"], expected: "ask" },
			{ name: "denylist に一致", text: "rm -rf /", allowed: ["npm"], denied: ["rm"], expected: "deny" },
			{
				name: "denylist の方が長い前方一致",
				text: "git push --force",
				allowed: ["git"],
				denied: ["git push"],
				expected: "deny",
			},
			{
				name: "allowlist の方が長い前方一致",
				text: "git push --dry-run",
				allowed: ["git push --dry-run"],
				denied: ["git push"],
				expected: "approve",
			},
			{
				name: "チェーンの一部が denylist",
				text: "npm run build && rm -rf /",
				allowed: ["npm"],
				denied: ["rm"],
				expected: "deny",
			},
			{
				name: "危険なパラメータ展開は allowlist に載っていても ask",
				text: 'echo "${var@P}"',
				allowed: ["echo"],
				expected: "ask",
			},
			{
				name: "denylist だけ未設定でも allowlist 一致なら approve",
				text: "npm test",
				allowed: ["npm"],
				denied: undefined,
				expected: "approve",
			},
		]

		it.each(commandCases)("$name は $expected", async ({ text, allowed, denied, expected }) => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: allowed,
					deniedCommands: denied,
				},
				ask: "command",
				text,
			})

			expect(result.decision).toBe(expected)
		})
	})

	describe("tool（ファイル操作など）", () => {
		it("JSON が壊れていれば ask", async () => {
			const result = await checkAutoApproval({
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
				ask: "tool",
				text: "{壊れた JSON",
			})

			expect(result.decision).toBe("ask")
		})

		it.each(["null", undefined])("tool ペイロードが %s なら ask", async (text) => {
			const result = await checkAutoApproval({
				state: { ...ALL_TOGGLES_ON, autoApprovalEnabled: true },
				ask: "tool",
				text,
			})

			expect(result.decision).toBe("ask")
		})

		// updateTodoList / skill は個別トグルを持たず、autoApprovalEnabled だけで承認される。
		it.each(["updateTodoList", "skill"])(
			"%s は個別トグルが一切無くても approve（実装上の意図的な例外）",
			async (tool) => {
				const result = await checkAutoApproval({
					state: ONLY_MASTER_ON,
					ask: "tool",
					text: JSON.stringify({ tool }),
				})

				expect(result.decision).toBe("approve")
			},
		)

		it.each([
			{ tool: "newTask", toggle: true, expected: "approve" },
			{ tool: "newTask", toggle: false, expected: "ask" },
			{ tool: "finishTask", toggle: true, expected: "approve" },
			{ tool: "finishTask", toggle: undefined, expected: "ask" },
		])("$tool: alwaysAllowSubtasks=$toggle → $expected", async ({ tool, toggle, expected }) => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowSubtasks: toggle },
				ask: "tool",
				text: JSON.stringify({ tool }),
			})

			expect(result.decision).toBe(expected)
		})

		describe("読み取り系ツール × ワークスペース外フラグ", () => {
			const readOnlyTools = [
				"readFile",
				"listFiles",
				"listFilesTopLevel",
				"listFilesRecursive",
				"searchFiles",
				"codebaseSearch",
				"runSlashCommand",
			]

			it.each(readOnlyTools)("%s は alwaysAllowReadOnly が on なら approve", async (tool) => {
				const result = await checkAutoApproval({
					state: { autoApprovalEnabled: true, alwaysAllowReadOnly: true },
					ask: "tool",
					text: JSON.stringify({ tool }),
				})

				expect(result.decision).toBe("approve")
			})

			const readMatrix: Array<{
				readOnly?: boolean
				outsideOpt?: boolean
				isOutsideWorkspace?: boolean
				expected: string
			}> = [
				{ readOnly: true, outsideOpt: undefined, isOutsideWorkspace: false, expected: "approve" },
				{ readOnly: true, outsideOpt: undefined, isOutsideWorkspace: true, expected: "ask" },
				{ readOnly: true, outsideOpt: false, isOutsideWorkspace: true, expected: "ask" },
				{ readOnly: true, outsideOpt: true, isOutsideWorkspace: true, expected: "approve" },
				{ readOnly: true, outsideOpt: true, isOutsideWorkspace: undefined, expected: "approve" },
				{ readOnly: false, outsideOpt: true, isOutsideWorkspace: false, expected: "ask" },
				{ readOnly: undefined, outsideOpt: true, isOutsideWorkspace: false, expected: "ask" },
			]

			it.each(readMatrix)(
				"readFile: readOnly=$readOnly outsideOpt=$outsideOpt outside=$isOutsideWorkspace → $expected",
				async ({ readOnly, outsideOpt, isOutsideWorkspace, expected }) => {
					const result = await checkAutoApproval({
						state: {
							autoApprovalEnabled: true,
							alwaysAllowReadOnly: readOnly,
							alwaysAllowReadOnlyOutsideWorkspace: outsideOpt,
						},
						ask: "tool",
						text: toolText({ tool: "readFile", path: "a.ts", isOutsideWorkspace }),
					})

					expect(result.decision).toBe(expected)
				},
			)
		})

		describe("書き込み系ツール × ワークスペース外 × 保護ファイル", () => {
			it.each(["editedExistingFile", "appliedDiff", "newFileCreated"])(
				"%s は alwaysAllowWrite が on なら approve",
				async (tool) => {
					const result = await checkAutoApproval({
						state: { autoApprovalEnabled: true, alwaysAllowWrite: true },
						ask: "tool",
						text: JSON.stringify({ tool }),
					})

					expect(result.decision).toBe("approve")
				},
			)

			const writeMatrix: Array<{
				write?: boolean
				outsideOpt?: boolean
				protectedOpt?: boolean
				isOutsideWorkspace?: boolean
				isProtected?: boolean
				expected: string
			}> = [
				{ write: true, isOutsideWorkspace: false, isProtected: false, expected: "approve" },
				{ write: true, isOutsideWorkspace: true, expected: "ask" },
				{ write: true, outsideOpt: false, isOutsideWorkspace: true, expected: "ask" },
				{ write: true, outsideOpt: true, isOutsideWorkspace: true, expected: "approve" },
				{ write: true, isProtected: true, expected: "ask" },
				{ write: true, protectedOpt: false, isProtected: true, expected: "ask" },
				{ write: true, protectedOpt: true, isProtected: true, expected: "approve" },
				{
					write: true,
					outsideOpt: true,
					protectedOpt: true,
					isOutsideWorkspace: true,
					isProtected: true,
					expected: "approve",
				},
				{
					write: true,
					outsideOpt: true,
					protectedOpt: false,
					isOutsideWorkspace: true,
					isProtected: true,
					expected: "ask",
				},
				{ write: false, outsideOpt: true, protectedOpt: true, expected: "ask" },
				{ write: undefined, expected: "ask" },
			]

			it.each(writeMatrix)(
				"newFileCreated: write=$write outsideOpt=$outsideOpt protectedOpt=$protectedOpt outside=$isOutsideWorkspace protected=$isProtected → $expected",
				async ({ write, outsideOpt, protectedOpt, isOutsideWorkspace, isProtected, expected }) => {
					const result = await checkAutoApproval({
						state: {
							autoApprovalEnabled: true,
							alwaysAllowWrite: write,
							alwaysAllowWriteOutsideWorkspace: outsideOpt,
							alwaysAllowWriteProtected: protectedOpt,
						},
						ask: "tool",
						text: toolText({ tool: "newFileCreated", path: "a.ts", isOutsideWorkspace }),
						isProtected,
					})

					expect(result.decision).toBe(expected)
				},
			)

			// ワークスペース外判定はペイロードの isOutsideWorkspace フラグのみが根拠で、
			// path を見た検証はこの層では行われない（呼び出し側の責務）。
			it("path がワークスペース外でも isOutsideWorkspace フラグが無ければ「内側」として扱われる", async () => {
				const result = await checkAutoApproval({
					state: { autoApprovalEnabled: true, alwaysAllowWrite: true },
					ask: "tool",
					text: toolText({ tool: "editedExistingFile", path: "/etc/hosts" }),
				})

				expect(result.decision).toBe("approve")
			})

			// 同様に、保護ファイルかどうかも呼び出し側から渡される isProtected だけで決まる。
			it("tool.isProtected がペイロードにあっても引数の isProtected が無ければ保護扱いされない", async () => {
				const result = await checkAutoApproval({
					state: { autoApprovalEnabled: true, alwaysAllowWrite: true },
					ask: "tool",
					text: toolText({ tool: "appliedDiff", path: ".env", isProtected: true }),
				})

				expect(result.decision).toBe("approve")
			})
		})
	})
})
