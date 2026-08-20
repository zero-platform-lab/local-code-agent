// npx vitest run src/components/chat/__tests__/chatTextAreaInput.spec.ts

import { ContextMenuOptionType } from "@src/utils/context-mentions"

import { buildContextMenuQueryItems, buildMentionInsertion } from "../chatTextAreaInput"

const values = (items: { value: string }[]) => items.map((i) => i.value)

describe("buildContextMenuQueryItems", () => {
	const empty = { gitCommits: [], openedTabs: [], filePaths: [] }

	it("always offers the two special entries first", () => {
		expect(buildContextMenuQueryItems(empty)).toEqual([
			{ type: ContextMenuOptionType.Problems, value: "problems" },
			{ type: ContextMenuOptionType.Terminal, value: "terminal" },
		])
	})

	it("keeps the order specials → commits → open tabs → other files", () => {
		const items = buildContextMenuQueryItems({
			gitCommits: [{ type: ContextMenuOptionType.Git, value: "abc123" }],
			openedTabs: [{ path: "open.ts" }],
			filePaths: ["other.ts"],
		})

		expect(values(items)).toEqual(["problems", "terminal", "abc123", "/open.ts", "/other.ts"])
	})

	it("prefixes tab and file paths with a slash", () => {
		const items = buildContextMenuQueryItems({ ...empty, openedTabs: [{ path: "a/b.ts" }], filePaths: ["c/d.ts"] })

		expect(values(items)).toContain("/a/b.ts")
		expect(values(items)).toContain("/c/d.ts")
	})

	it("skips tabs that have no path", () => {
		const items = buildContextMenuQueryItems({ ...empty, openedTabs: [{}, { path: "real.ts" }] })

		expect(values(items)).toEqual(["problems", "terminal", "/real.ts"])
	})

	it("does not list a file twice when it is already an open tab", () => {
		const items = buildContextMenuQueryItems({ ...empty, openedTabs: [{ path: "a.ts" }], filePaths: ["a.ts"] })

		expect(values(items).filter((v) => v === "/a.ts")).toHaveLength(1)
	})

	it("marks the deduplicated entry as an open file, not a plain file", () => {
		const items = buildContextMenuQueryItems({ ...empty, openedTabs: [{ path: "a.ts" }], filePaths: ["a.ts"] })

		expect(items.find((i) => i.value === "/a.ts")?.type).toBe(ContextMenuOptionType.OpenedFile)
	})

	it("classifies a trailing slash as a folder", () => {
		const items = buildContextMenuQueryItems({ ...empty, filePaths: ["src/", "src/a.ts"] })

		expect(items.find((i) => i.value === "/src/")?.type).toBe(ContextMenuOptionType.Folder)
		expect(items.find((i) => i.value === "/src/a.ts")?.type).toBe(ContextMenuOptionType.File)
	})

	it("passes git commits through untouched", () => {
		const commit = { type: ContextMenuOptionType.Git, value: "deadbeef" }

		expect(buildContextMenuQueryItems({ ...empty, gitCommits: [commit] })[2]).toBe(commit)
	})
})

describe("buildMentionInsertion", () => {
	const base = { inputValue: "", cursorPosition: 0, cwd: "/ws" }

	it("returns nothing when the dropped text has no usable lines", () => {
		expect(buildMentionInsertion({ ...base, text: "" })).toBeUndefined()
		expect(buildMentionInsertion({ ...base, text: "   \n\t\n" })).toBeUndefined()
	})

	it("inserts a single mention followed by a space", () => {
		const result = buildMentionInsertion({ ...base, text: "/ws/a.ts" })

		expect(result?.newValue).toBe("@/a.ts ")
		expect(result?.newCursorPosition).toBe("@/a.ts ".length)
	})

	it("separates multiple mentions with a single space and ends with one", () => {
		const result = buildMentionInsertion({ ...base, text: "/ws/a.ts\n/ws/b.ts" })

		expect(result?.newValue).toBe("@/a.ts @/b.ts ")
	})

	it("drops blank lines between paths", () => {
		const result = buildMentionInsertion({ ...base, text: "/ws/a.ts\n\n  \n/ws/b.ts" })

		expect(result?.newValue).toBe("@/a.ts @/b.ts ")
	})

	it("handles CRLF line endings", () => {
		const result = buildMentionInsertion({ ...base, text: "/ws/a.ts\r\n/ws/b.ts" })

		expect(result?.newValue).toBe("@/a.ts @/b.ts ")
	})

	it("splices into the middle of existing text at the cursor", () => {
		const result = buildMentionInsertion({
			text: "/ws/a.ts",
			inputValue: "before after",
			cursorPosition: "before ".length,
			cwd: "/ws",
		})

		expect(result?.newValue).toBe("before @/a.ts after")
	})

	it("leaves the cursor right after the inserted text", () => {
		const result = buildMentionInsertion({
			text: "/ws/a.ts",
			inputValue: "before after",
			cursorPosition: "before ".length,
			cwd: "/ws",
		})

		expect(result?.newValue.slice(0, result.newCursorPosition)).toBe("before @/a.ts ")
	})

	it("appends at the end when the cursor is at the end", () => {
		const result = buildMentionInsertion({ text: "/ws/a.ts", inputValue: "hi ", cursorPosition: 3, cwd: "/ws" })

		expect(result?.newValue).toBe("hi @/a.ts ")
		expect(result?.newCursorPosition).toBe("hi @/a.ts ".length)
	})

	it("works without a cwd", () => {
		const result = buildMentionInsertion({ text: "/abs/path.ts", inputValue: "", cursorPosition: 0 })

		expect(result?.newValue.endsWith(" ")).toBe(true)
		expect(result?.newCursorPosition).toBe(result?.newValue.length)
	})
})
