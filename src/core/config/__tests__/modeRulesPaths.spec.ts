// npx vitest run core/config/__tests__/modeRulesPaths.spec.ts

import * as path from "path"

import { resolveModeRulesDir, resolveRuleFileTarget } from "../modeRulesPaths"

const bases = { workspacePath: "/ws", globalAgentDir: "/home/u/.agent" }

describe("resolveModeRulesDir", () => {
	it("puts global mode rules under the global agent directory", () => {
		expect(resolveModeRulesDir({ slug: "sre", scope: "global", ...bases })).toBe(
			path.join("/home/u/.agent", "rules-sre"),
		)
	})

	it("puts project mode rules under <workspace>/.agent", () => {
		expect(resolveModeRulesDir({ slug: "sre", scope: "project", ...bases })).toBe(
			path.join("/ws", ".agent", "rules-sre"),
		)
	})

	it("resolves global rules even without a workspace", () => {
		expect(resolveModeRulesDir({ slug: "sre", scope: "global", ...bases, workspacePath: undefined })).toBe(
			path.join("/home/u/.agent", "rules-sre"),
		)
	})

	it("returns undefined for a project mode when there is no workspace", () => {
		expect(
			resolveModeRulesDir({ slug: "sre", scope: "project", ...bases, workspacePath: undefined }),
		).toBeUndefined()
	})
})

describe("resolveRuleFileTarget", () => {
	const root = path.join("/ws", ".agent", "rules-sre")

	it("joins a plain relative path onto the rules folder", () => {
		expect(resolveRuleFileTarget(root, "01-style.md")).toEqual({
			ok: true,
			targetPath: path.join(root, "01-style.md"),
		})
	})

	it("keeps nested directories", () => {
		expect(resolveRuleFileTarget(root, "sub/dir/rule.md")).toEqual({
			ok: true,
			targetPath: path.join(root, "sub/dir/rule.md"),
		})
	})

	it("strips a legacy rules-* prefix and reports it", () => {
		const result = resolveRuleFileTarget(root, "rules-sre/01-style.md")

		expect(result).toEqual({
			ok: true,
			targetPath: path.join(root, "01-style.md"),
			strippedLegacyPrefix: "rules-sre/",
		})
	})

	it("strips a legacy prefix whose slug differs from the target folder", () => {
		// 旧 export はフォルダ名を含むので、slug 変更後の import でも剥がす必要がある。
		const result = resolveRuleFileTarget(root, "rules-old-name/01-style.md")

		expect(result.ok).toBe(true)
		expect(result.ok && result.targetPath).toBe(path.join(root, "01-style.md"))
	})

	it("rejects parent-directory traversal", () => {
		expect(resolveRuleFileTarget(root, "../../etc/passwd")).toEqual({ ok: false, reason: "invalid-path" })
	})

	it("rejects traversal hidden inside a longer path", () => {
		expect(resolveRuleFileTarget(root, "sub/../../escape.md")).toEqual({ ok: false, reason: "invalid-path" })
	})

	it("rejects absolute paths", () => {
		expect(resolveRuleFileTarget(root, "/etc/passwd")).toEqual({ ok: false, reason: "invalid-path" })
	})

	it("does not report a legacy prefix for a folder that merely starts with 'rules'", () => {
		const result = resolveRuleFileTarget(root, "rulesets/a.md")

		expect(result).toEqual({ ok: true, targetPath: path.join(root, "rulesets/a.md") })
	})

	it("treats a bare rules-* path segment with no file as a normal path", () => {
		expect(resolveRuleFileTarget(root, "rules-sre")).toEqual({ ok: true, targetPath: path.join(root, "rules-sre") })
	})

	it("rejects with path-traversal when the joined result escapes the rules folder", () => {
		// 2 段目のガード（結合後の再確認）を踏むケース。
		// 1 段目（".." / 絶対パス）を通り抜けても、join 後のパスが rules フォルダの外に
		// なるなら path-traversal で弾く。空文字の rulesFolderPath では
		// path.join("", "01.md") = "01.md" が normalize("") = "." の外に出る。
		// 本番の rulesFolderPath は resolveModeRulesDir が返す絶対パスなので実際には
		// この経路には入らないが、書き込み先を rules フォルダ内に閉じ込める不変条件そのものは
		// 相対 root で必ず発火することを固定する。
		expect(resolveRuleFileTarget("", "01.md")).toEqual({ ok: false, reason: "path-traversal" })
	})
})
