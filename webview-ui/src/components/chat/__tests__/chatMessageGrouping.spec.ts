// npx vitest run src/components/chat/__tests__/chatMessageGrouping.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { condensingPlaceholder, groupChatMessages } from "../chatMessageGrouping"

let nextTs = 1

const toolAsk = (tool: Record<string, unknown>): ClineMessage =>
	({ type: "ask", ask: "tool", ts: nextTs++, text: JSON.stringify(tool) }) as ClineMessage

const text = (body: string): ClineMessage => ({ type: "say", say: "text", ts: nextTs++, text: body }) as ClineMessage

const payloadOf = (message: ClineMessage) => JSON.parse(message.text || "{}")

beforeEach(() => {
	nextTs = 1
})

describe("groupChatMessages — leaves things alone", () => {
	it("returns non-tool messages untouched", () => {
		const messages = [text("a"), text("b")]

		expect(groupChatMessages(messages)).toEqual(messages)
	})

	it("does not batch a lone approval request", () => {
		const messages = [toolAsk({ tool: "readFile", path: "a.ts" })]

		expect(groupChatMessages(messages)).toEqual(messages)
		expect(payloadOf(groupChatMessages(messages)[0]).batchFiles).toBeUndefined()
	})

	it("does not batch requests separated by another message", () => {
		const messages = [
			toolAsk({ tool: "readFile", path: "a.ts" }),
			text("something happened"),
			toolAsk({ tool: "readFile", path: "b.ts" }),
		]

		expect(groupChatMessages(messages)).toHaveLength(3)
	})

	it("does not batch different tool families together", () => {
		const messages = [
			toolAsk({ tool: "readFile", path: "a.ts" }),
			toolAsk({ tool: "listFilesTopLevel", path: "x" }),
		]

		expect(groupChatMessages(messages)).toHaveLength(2)
	})

	it("leaves an empty list empty", () => {
		expect(groupChatMessages([])).toEqual([])
	})
})

describe("groupChatMessages — read_file", () => {
	it("folds consecutive reads into one message keyed by path and reason", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "readFile", path: "a.ts", reason: "lines 1-5", content: "A" }),
			toolAsk({ tool: "readFile", path: "b.ts" }),
		])

		expect(grouped).toHaveLength(1)
		expect(payloadOf(grouped[0]).batchFiles).toEqual([
			{
				path: "a.ts",
				lineSnippet: "lines 1-5",
				isOutsideWorkspace: false,
				key: "a.ts (lines 1-5)",
				content: "A",
			},
			{ path: "b.ts", lineSnippet: "", isOutsideWorkspace: false, key: "b.ts", content: "" },
		])
	})

	it("keeps the first message as the carrier", () => {
		const first = toolAsk({ tool: "readFile", path: "a.ts" })
		const grouped = groupChatMessages([first, toolAsk({ tool: "readFile", path: "b.ts" })])

		expect(grouped[0].ts).toBe(first.ts)
		expect(payloadOf(grouped[0]).tool).toBe("readFile")
	})

	it("carries isOutsideWorkspace through per entry", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "readFile", path: "a.ts", isOutsideWorkspace: true }),
			toolAsk({ tool: "readFile", path: "b.ts" }),
		])

		expect(payloadOf(grouped[0]).batchFiles.map((f: any) => f.isOutsideWorkspace)).toEqual([true, false])
	})

	it("does not re-batch a message that already carries batchFiles", () => {
		const messages = [
			toolAsk({ tool: "readFile", path: "a.ts", batchFiles: [{ path: "a.ts" }] }),
			toolAsk({ tool: "readFile", path: "b.ts", batchFiles: [{ path: "b.ts" }] }),
		]

		expect(groupChatMessages(messages)).toHaveLength(2)
	})
})

describe("groupChatMessages — list_files", () => {
	it("folds top-level and recursive listings together, recording recursion per entry", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "listFilesTopLevel", path: "src" }),
			toolAsk({ tool: "listFilesRecursive", path: "test" }),
		])

		expect(grouped).toHaveLength(1)
		expect(payloadOf(grouped[0]).batchDirs).toEqual([
			{ path: "src", recursive: false, isOutsideWorkspace: false, key: "src" },
			{ path: "test", recursive: true, isOutsideWorkspace: false, key: "test" },
		])
	})

	it("does not re-batch a message that already carries batchDirs", () => {
		const messages = [
			toolAsk({ tool: "listFilesTopLevel", path: "a", batchDirs: [] }),
			toolAsk({ tool: "listFilesTopLevel", path: "b", batchDirs: [] }),
		]

		expect(groupChatMessages(messages)).toHaveLength(2)
	})
})

describe("groupChatMessages — file edits", () => {
	it.each(["editedExistingFile", "appliedDiff", "newFileCreated", "insertContent", "searchAndReplace"])(
		"treats %s as a file edit",
		(tool) => {
			const grouped = groupChatMessages([toolAsk({ tool, path: "a.ts" }), toolAsk({ tool, path: "b.ts" })])

			expect(grouped).toHaveLength(1)
			expect(payloadOf(grouped[0]).batchDiffs).toHaveLength(2)
		},
	)

	it("prefers content over diff, and carries diffStats", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "appliedDiff", path: "a.ts", content: "C", diff: "D", diffStats: { added: 1 } }),
			toolAsk({ tool: "appliedDiff", path: "b.ts", diff: "D2" }),
		])

		expect(payloadOf(grouped[0]).batchDiffs).toEqual([
			{ path: "a.ts", changeCount: 1, key: "a.ts", content: "C", diffStats: { added: 1 } },
			{ path: "b.ts", changeCount: 1, key: "b.ts", content: "D2" },
		])
	})

	it("does not re-batch a message that already carries batchDiffs", () => {
		const messages = [
			toolAsk({ tool: "appliedDiff", path: "a.ts", batchDiffs: [] }),
			toolAsk({ tool: "appliedDiff", path: "b.ts", batchDiffs: [] }),
		]

		expect(groupChatMessages(messages)).toHaveLength(2)
	})
})

describe("groupChatMessages — malformed payloads", () => {
	it("never batches a message whose JSON is broken", () => {
		const broken = { type: "ask", ask: "tool", ts: 1, text: "{not json" } as ClineMessage
		const messages = [broken, toolAsk({ tool: "readFile", path: "b.ts" })]

		expect(groupChatMessages(messages)).toHaveLength(2)
	})

	it("keeps a broken message out of an otherwise batchable run", () => {
		const broken = { type: "ask", ask: "tool", ts: 99, text: "{oops" } as ClineMessage
		const grouped = groupChatMessages([
			toolAsk({ tool: "readFile", path: "a.ts" }),
			broken,
			toolAsk({ tool: "readFile", path: "b.ts" }),
		])

		expect(grouped).toHaveLength(3)
	})
})

describe("groupChatMessages — missing fields", () => {
	it("treats an ask with no text as an unrelated message", () => {
		const bare = { type: "ask", ask: "tool", ts: nextTs++ } as ClineMessage

		expect(groupChatMessages([bare, bare])).toEqual([bare, bare])
	})

	it("falls back to empty strings when a read carries no path", () => {
		const grouped = groupChatMessages([toolAsk({ tool: "readFile" }), toolAsk({ tool: "readFile" })])

		expect(grouped).toHaveLength(1)
		expect(payloadOf(grouped[0]).batchFiles).toEqual([
			{ path: "", lineSnippet: "", isOutsideWorkspace: false, key: "undefined", content: "" },
			{ path: "", lineSnippet: "", isOutsideWorkspace: false, key: "undefined", content: "" },
		])
	})

	it("falls back to empty strings when a listing carries no path", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "listFilesTopLevel" }),
			toolAsk({ tool: "listFilesTopLevel" }),
		])

		expect(grouped).toHaveLength(1)
		expect(payloadOf(grouped[0]).batchDirs).toEqual([
			{ path: "", recursive: false, isOutsideWorkspace: false, key: "" },
			{ path: "", recursive: false, isOutsideWorkspace: false, key: "" },
		])
	})

	it("falls back to empty strings when an edit carries neither path nor body", () => {
		const grouped = groupChatMessages([toolAsk({ tool: "appliedDiff" }), toolAsk({ tool: "appliedDiff" })])

		expect(grouped).toHaveLength(1)
		expect(payloadOf(grouped[0]).batchDiffs).toEqual([
			{ path: "", changeCount: 1, key: "", content: "" },
			{ path: "", changeCount: 1, key: "", content: "" },
		])
	})
})

describe("groupChatMessages — multiple families in one pass", () => {
	it("batches each family independently and keeps their order", () => {
		const grouped = groupChatMessages([
			toolAsk({ tool: "readFile", path: "a.ts" }),
			toolAsk({ tool: "readFile", path: "b.ts" }),
			toolAsk({ tool: "listFilesTopLevel", path: "src" }),
			toolAsk({ tool: "listFilesTopLevel", path: "test" }),
			toolAsk({ tool: "appliedDiff", path: "c.ts" }),
			toolAsk({ tool: "appliedDiff", path: "d.ts" }),
		])

		expect(grouped).toHaveLength(3)
		expect(payloadOf(grouped[0]).batchFiles).toHaveLength(2)
		expect(payloadOf(grouped[1]).batchDirs).toHaveLength(2)
		expect(payloadOf(grouped[2]).batchDiffs).toHaveLength(2)
	})

	it("does not fold a synthesized batch into the next family's pass", () => {
		// 合成結果には batchFiles が入るので、後続 pass の対象から外れる。
		const grouped = groupChatMessages([
			toolAsk({ tool: "readFile", path: "a.ts" }),
			toolAsk({ tool: "readFile", path: "b.ts" }),
		])

		expect(payloadOf(grouped[0]).batchDirs).toBeUndefined()
		expect(payloadOf(grouped[0]).batchDiffs).toBeUndefined()
	})
})

describe("groupChatMessages — condensing indicator", () => {
	it("appends a streaming condense row while condensing", () => {
		const grouped = groupChatMessages([text("a")], { isCondensing: true })

		expect(grouped).toHaveLength(2)
		expect(grouped.at(-1)).toMatchObject({ type: "say", say: "condense_context", partial: true })
	})

	it("appends nothing when not condensing", () => {
		expect(groupChatMessages([text("a")], { isCondensing: false })).toHaveLength(1)
		expect(groupChatMessages([text("a")])).toHaveLength(1)
	})

	it("does not mutate the input array", () => {
		const messages = [text("a")]

		groupChatMessages(messages, { isCondensing: true })

		expect(messages).toHaveLength(1)
	})
})

describe("condensingPlaceholder", () => {
	it("builds a partial condense_context row at the given timestamp", () => {
		expect(condensingPlaceholder(42)).toEqual({ type: "say", say: "condense_context", ts: 42, partial: true })
	})
})
