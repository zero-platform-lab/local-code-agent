// npx vitest run src/__tests__/barrel-exports.spec.ts
//
// バレル（再エクスポート専用）ファイルの実行を固定する。
// index.ts / cli.ts / browser.ts / worktree/index.ts / message-utils/index.ts は
// `export * from` と named re-export だけで構成され、副作用は安全なシングルトン生成
// （WorktreeService / DebugLogger の new）のみ。import すれば各 re-export 文が評価され
// C0/C1/関数 100% になる。本物の git / fs は起動しない。

import * as browser from "../browser.js"
import * as cli from "../cli.js"
import * as index from "../index.js"
import * as messageUtils from "../message-utils/index.js"
import * as worktree from "../worktree/index.js"

describe("barrel exports", () => {
	it("index.ts は debug-log / message-utils / task-history / worktree を束ねて公開する", () => {
		expect(typeof index.debugLog).toBe("function")
		expect(typeof index.consolidateApiRequests).toBe("function")
		expect(typeof index.consolidateTokenUsage).toBe("function")
		expect(typeof index.consolidateCommands).toBe("function")
		expect(typeof index.safeJsonParse).toBe("function")
		expect(typeof index.WorktreeService).toBe("function")
		expect(typeof index.WorktreeIncludeService).toBe("function")
	})

	it("cli.ts は debug-log / message-utils / task-history を公開する（worktree は含めない）", () => {
		expect(typeof cli.debugLog).toBe("function")
		expect(typeof cli.consolidateApiRequests).toBe("function")
		expect(typeof cli.safeJsonParse).toBe("function")
		// browser/worktree 専用 API は cli には出さない
		expect((cli as Record<string, unknown>).WorktreeService).toBeUndefined()
	})

	it("browser.ts は message-utils だけを公開する", () => {
		expect(typeof browser.consolidateApiRequests).toBe("function")
		expect(typeof browser.consolidateTokenUsage).toBe("function")
		expect(typeof browser.consolidateCommands).toBe("function")
		expect(typeof browser.safeJsonParse).toBe("function")
		// fs 依存の debug-log / worktree は browser には出さない
		expect((browser as Record<string, unknown>).debugLog).toBeUndefined()
		expect((browser as Record<string, unknown>).WorktreeService).toBeUndefined()
	})

	it("worktree/index.ts はサービスとシングルトンを公開する", () => {
		expect(typeof worktree.WorktreeService).toBe("function")
		expect(typeof worktree.WorktreeIncludeService).toBe("function")
		expect(worktree.worktreeService).toBeInstanceOf(worktree.WorktreeService)
		expect(worktree.worktreeIncludeService).toBeInstanceOf(worktree.WorktreeIncludeService)
	})

	it("message-utils/index.ts は集計・変換ユーティリティを公開する", () => {
		expect(typeof messageUtils.consolidateApiRequests).toBe("function")
		expect(typeof messageUtils.consolidateCommands).toBe("function")
		expect(typeof messageUtils.consolidateTokenUsage).toBe("function")
		expect(typeof messageUtils.hasTokenUsageChanged).toBe("function")
		expect(typeof messageUtils.hasToolUsageChanged).toBe("function")
		expect(typeof messageUtils.safeJsonParse).toBe("function")
		expect(messageUtils.COMMAND_OUTPUT_STRING).toBe("Output:")
	})
})
