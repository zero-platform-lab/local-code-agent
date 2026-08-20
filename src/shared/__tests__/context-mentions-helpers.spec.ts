// npx vitest run shared/__tests__/context-mentions-helpers.spec.ts

import { formatGitSuggestion, unescapeSpaces } from "../context-mentions"

describe("formatGitSuggestion", () => {
	it("コミット情報から git サジェストを構築する", () => {
		const suggestion = formatGitSuggestion({
			hash: "abcdef1234567890",
			shortHash: "abcdef1",
			subject: "Fix the bug",
			author: "Alice",
			date: "2026-01-01",
		})

		expect(suggestion).toEqual({
			type: "git",
			label: "Fix the bug",
			description: "abcdef1 by Alice on 2026-01-01",
			value: "abcdef1234567890",
			icon: "$(git-commit)",
			hash: "abcdef1234567890",
			shortHash: "abcdef1",
			subject: "Fix the bug",
			author: "Alice",
			date: "2026-01-01",
		})
	})
})

describe("unescapeSpaces", () => {
	it("バックスラッシュエスケープされた空白を戻す", () => {
		expect(unescapeSpaces("path/to/my\\ file.txt")).toBe("path/to/my file.txt")
	})

	it("エスケープが無ければそのまま返す", () => {
		expect(unescapeSpaces("no-spaces")).toBe("no-spaces")
	})

	it("複数のエスケープ空白をすべて戻す", () => {
		expect(unescapeSpaces("a\\ b\\ c")).toBe("a b c")
	})
})
