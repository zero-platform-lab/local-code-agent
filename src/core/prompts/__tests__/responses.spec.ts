// npx vitest run core/prompts/__tests__/responses.spec.ts

import { formatResponse } from "../responses"

// 外部 fs に触れない軽量フェイク。formatFilesList の分岐だけを制御する。
type IgnoreLike = { validateAccess: (p: string) => boolean }
type ProtectLike = { isWriteProtected: (p: string) => boolean }

const parse = (s: string) => JSON.parse(s) as Record<string, any>

describe("formatResponse ステータス系メッセージ (JSON 形状の不変条件)", () => {
	it("toolDenied は denied ステータス", () => {
		expect(parse(formatResponse.toolDenied())).toEqual({
			status: "denied",
			message: "The user denied this operation.",
		})
	})

	it("toolDeniedWithFeedback は feedback を保持する", () => {
		expect(parse(formatResponse.toolDeniedWithFeedback("nope"))).toEqual({
			status: "denied",
			feedback: "nope",
		})
	})

	it("toolApprovedWithFeedback は approved ステータス", () => {
		expect(parse(formatResponse.toolApprovedWithFeedback("ok"))).toEqual({
			status: "approved",
			feedback: "ok",
		})
	})

	it("toolError は error ステータスとエラー詳細", () => {
		const r = parse(formatResponse.toolError("boom"))
		expect(r.status).toBe("error")
		expect(r.error).toBe("boom")
	})

	it("tooManyMistakes は guidance ステータス", () => {
		expect(parse(formatResponse.tooManyMistakes("slow down"))).toEqual({
			status: "guidance",
			feedback: "slow down",
		})
	})

	it("invalidMcpToolArgumentError はサーバ/ツール名を含む", () => {
		const r = parse(formatResponse.invalidMcpToolArgumentError("srv", "tool"))
		expect(r.status).toBe("error")
		expect(r.type).toBe("invalid_argument")
		expect(r.server).toBe("srv")
		expect(r.tool).toBe("tool")
	})

	it("unknownMcpToolError は利用可能ツール一覧を含む（空なら空配列）", () => {
		const withTools = parse(formatResponse.unknownMcpToolError("srv", "t", ["a", "b"]))
		expect(withTools.available_tools).toEqual(["a", "b"])
		const empty = parse(formatResponse.unknownMcpToolError("srv", "t", []))
		expect(empty.available_tools).toEqual([])
	})

	it("unknownMcpServerError は利用可能サーバ一覧を含む（空なら空配列）", () => {
		const withServers = parse(formatResponse.unknownMcpServerError("srv", ["x"]))
		expect(withServers.available_servers).toEqual(["x"])
		const empty = parse(formatResponse.unknownMcpServerError("srv", []))
		expect(empty.available_servers).toEqual([])
	})
})

describe("formatResponse.noToolsUsed / missingToolParameterError (ツール利用リマインダ)", () => {
	it("noToolsUsed はツール未使用の指摘とリマインダを含む", () => {
		const msg = formatResponse.noToolsUsed()
		expect(msg).toContain("You did not use a tool")
		expect(msg).toContain("Reminder: Instructions for Tool Use")
		expect(msg).toContain("attempt_completion")
	})

	it("missingToolParameterError はパラメータ名とリマインダを含む", () => {
		const msg = formatResponse.missingToolParameterError("path")
		expect(msg).toContain("Missing value for required parameter 'path'")
		expect(msg).toContain("Reminder: Instructions for Tool Use")
	})
})

describe("formatResponse.toolResult / imageBlocks", () => {
	it("画像なしなら text をそのまま返す", () => {
		expect(formatResponse.toolResult("hello")).toBe("hello")
		expect(formatResponse.toolResult("hello", [])).toBe("hello")
	})

	it("画像ありなら text ブロックの後に画像ブロックを並べる", () => {
		const result = formatResponse.toolResult("caption", ["data:image/png;base64,AAAA"])
		expect(Array.isArray(result)).toBe(true)
		const blocks = result as Array<any>
		expect(blocks[0]).toEqual({ type: "text", text: "caption" })
		expect(blocks[1].type).toBe("image")
		expect(blocks[1].source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" })
	})

	it("imageBlocks は画像未指定なら空配列", () => {
		expect(formatResponse.imageBlocks()).toEqual([])
		expect(formatResponse.imageBlocks(["data:image/jpeg;base64,ZZ"])).toHaveLength(1)
	})
})

describe("formatResponse.createPrettyPatch", () => {
	it("差分ヘッダ 4 行を除いた diff 本文を返す", () => {
		const patch = formatResponse.createPrettyPatch("f.txt", "a\nb\nc", "a\nB\nc")
		// 変更行を含み、@@ ヘッダ以降だけが残る
		expect(patch).toContain("-b")
		expect(patch).toContain("+B")
	})

	it("旧/新未指定でも例外を投げない（既定は空文字）", () => {
		expect(() => formatResponse.createPrettyPatch()).not.toThrow()
	})
})

describe("formatResponse.formatFilesList", () => {
	it("ディレクトリ（末尾 /）は相対パスでも末尾 / を維持する", () => {
		const result = formatResponse.formatFilesList("/root", ["/root/dir/", "/root/a.ts"], false, undefined, false)
		expect(result).toContain("dir/")
		expect(result).toContain("a.ts")
	})

	it("ディレクトリはその配下ファイルより前に並ぶ", () => {
		const result = formatResponse.formatFilesList(
			"/root",
			["/root/src/z.ts", "/root/src/", "/root/src/a.ts", "/root/top.ts"],
			false,
			undefined,
			false,
		)
		const lines = result.split("\n")
		// src/ ディレクトリ行が src/ 配下ファイルより前
		expect(lines.indexOf("src/")).toBeLessThan(lines.indexOf("src/a.ts"))
		expect(lines.indexOf("src/a.ts")).toBeLessThan(lines.indexOf("src/z.ts"))
	})

	it("全成分が一致する場合は短いパス（親）が先に並ぶ", () => {
		// 相対パス "pkg" と "pkg/x.ts": 短い方の全成分が一致 → 長さ差でソート (comparator の末尾経路)
		const result = formatResponse.formatFilesList("/root", ["/root/pkg/x.ts", "/root/pkg"], false, undefined, false)
		const lines = result.split("\n")
		expect(lines.indexOf("pkg")).toBeLessThan(lines.indexOf("pkg/x.ts"))
	})

	it("didHitLimit で truncated メッセージを付ける", () => {
		const result = formatResponse.formatFilesList("/root", ["/root/a.ts"], true, undefined, false)
		expect(result).toContain("File list truncated")
	})

	it("空リストは 'No files found.'", () => {
		expect(formatResponse.formatFilesList("/root", [], false, undefined, false)).toBe("No files found.")
	})

	it("単一の空文字エントリも 'No files found.' 扱い", () => {
		// path.relative が空文字を返すケース（cwd 自身）で length===1 && [0]==="" 分岐
		const result = formatResponse.formatFilesList("/root", ["/root"], false, undefined, false)
		expect(result).toBe("No files found.")
	})

	it("ignore コントローラ: 無視ファイルはロック記号付き、非無視は書き込み保護記号を付ける", () => {
		const ignore: IgnoreLike = {
			// secrets 配下だけ無視
			validateAccess: (p: string) => !p.includes("secrets"),
		}
		const protect: ProtectLike = {
			// app.ts だけ書き込み保護
			isWriteProtected: (p: string) => p.includes("app.ts"),
		}
		const result = formatResponse.formatFilesList(
			"/root",
			["/root/app.ts", "/root/plain.ts", "/root/secrets/key"],
			false,
			ignore as any,
			true, // showAgentIgnoredFiles
			protect as any,
		)
		// 無視ファイルはロック記号
		expect(result).toMatch(/🔒.*secrets\/key/u)
		// 書き込み保護ファイルは盾記号
		expect(result).toMatch(/🛡️ app\.ts/u)
		// 通常ファイルは装飾なし
		expect(result).toContain("plain.ts")
	})

	it("ignore コントローラ + showAgentIgnoredFiles=false は無視ファイルを隠す", () => {
		const ignore: IgnoreLike = { validateAccess: (p: string) => !p.includes("secrets") }
		const result = formatResponse.formatFilesList(
			"/root",
			["/root/keep.ts", "/root/secrets/key"],
			false,
			ignore as any,
			false,
		)
		expect(result).toContain("keep.ts")
		expect(result).not.toContain("secrets/key")
	})
})
