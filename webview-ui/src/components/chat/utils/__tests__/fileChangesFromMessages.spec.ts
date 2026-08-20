import { fileChangesFromMessages } from "../fileChangesFromMessages"

// ClineMessage を最小限で組み立てるヘルパ
const say = (tool: unknown, extra: Record<string, unknown> = {}) =>
	({ ts: 1, type: "say", say: "tool", text: JSON.stringify(tool), ...extra }) as any

const ask = (tool: unknown, extra: Record<string, unknown> = {}) =>
	({ ts: 1, type: "ask", ask: "tool", text: JSON.stringify(tool), isAnswered: true, ...extra }) as any

describe("fileChangesFromMessages", () => {
	it("returns [] for undefined or empty input", () => {
		expect(fileChangesFromMessages(undefined)).toEqual([])
		expect(fileChangesFromMessages([])).toEqual([])
	})

	it("skips non-tool messages, partial messages and text-less messages", () => {
		const messages = [
			{ ts: 1, type: "say", say: "text", text: "hi" } as any,
			say({ tool: "editedExistingFile", path: "a.ts", diff: "d" }, { partial: true }),
			{ ts: 1, type: "say", say: "tool", text: undefined } as any,
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("skips ask 'tool' messages that have not been answered", () => {
		const messages = [ask({ tool: "editedExistingFile", path: "a.ts", diff: "d" }, { isAnswered: false })]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("includes answered ask 'tool' file edits", () => {
		const result = fileChangesFromMessages([
			ask({ tool: "appliedDiff", path: "a.ts", diff: "the-diff", diffStats: { added: 1, removed: 2 } }),
		])
		expect(result).toEqual([
			{ path: "a.ts", diff: "the-diff", diffStats: { added: 1, removed: 2 }, originalContent: undefined },
		])
	})

	it("skips messages whose text is not valid JSON", () => {
		const bad = { ts: 1, type: "say", say: "tool", text: "{not json" } as any
		expect(fileChangesFromMessages([bad])).toEqual([])
	})

	it("skips tools that are not file-edit tools", () => {
		expect(fileChangesFromMessages([say({ tool: "readFile", path: "a.ts", content: "x" })])).toEqual([])
	})

	it("expands batchDiffs, using content or joined diffs and skipping empties", () => {
		const result = fileChangesFromMessages([
			say({
				tool: "appliedDiff",
				batchDiffs: [
					{ path: "with-content.ts", content: "C", diffStats: { added: 1, removed: 0 } },
					{ path: "from-diffs.ts", diffs: [{ content: "d1" }, { content: "d2" }] },
					{ path: "empty.ts", content: "" },
					{ content: "no-path" }, // path 無しはスキップ
				],
			}),
		])
		expect(result).toEqual([
			{ path: "with-content.ts", diff: "C", diffStats: { added: 1, removed: 0 } },
			{ path: "from-diffs.ts", diff: "d1\nd2", diffStats: undefined },
		])
	})

	it("skips batch files that have neither content nor diffs", () => {
		const result = fileChangesFromMessages([
			say({
				tool: "appliedDiff",
				batchDiffs: [{ path: "empty.ts" }],
			}),
		])
		expect(result).toEqual([])
	})

	it("uses tool.content when tool.diff is absent for single-file edits", () => {
		const result = fileChangesFromMessages([say({ tool: "newFileCreated", path: "new.ts", content: "hello" })])
		expect(result).toEqual([{ path: "new.ts", diff: "hello", diffStats: undefined, originalContent: undefined }])
	})

	it("skips single-file edits with no path or empty diff", () => {
		expect(fileChangesFromMessages([say({ tool: "editedExistingFile", diff: "d" })])).toEqual([])
		// diff も content も無い → `tool.diff ?? tool.content ?? ""` が "" になりスキップ
		expect(fileChangesFromMessages([say({ tool: "editedExistingFile", path: "a.ts" })])).toEqual([])
	})
})
