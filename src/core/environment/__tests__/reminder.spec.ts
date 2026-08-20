// npx vitest core/environment/__tests__/reminder.spec.ts

import type { TodoItem } from "@openai-agent/types"

import { formatReminderSection } from "../reminder"

describe("formatReminderSection", () => {
	it("returns the empty-list guidance when todoList is undefined", () => {
		const result = formatReminderSection(undefined)
		expect(result).toContain("You have not created a todo list yet")
		expect(result).not.toContain("REMINDERS")
	})

	it("returns the empty-list guidance when todoList is empty", () => {
		const result = formatReminderSection([])
		expect(result).toContain("You have not created a todo list yet")
	})

	it("renders a markdown table mapping each known status to its label", () => {
		const todoList: TodoItem[] = [
			{ id: "1", content: "first", status: "pending" },
			{ id: "2", content: "second", status: "in_progress" },
			{ id: "3", content: "third", status: "completed" },
		]

		const result = formatReminderSection(todoList)

		expect(result).toContain("REMINDERS")
		expect(result).toContain("| # | Content | Status |")
		expect(result).toContain("| 1 | first | Pending |")
		expect(result).toContain("| 2 | second | In Progress |")
		expect(result).toContain("| 3 | third | Completed |")
	})

	it("escapes backslashes and pipes in content", () => {
		const todoList: TodoItem[] = [{ id: "1", content: "a|b\\c", status: "pending" }]

		const result = formatReminderSection(todoList)

		// パイプは "\|"、バックスラッシュは "\\" にエスケープされる
		expect(result).toContain("| 1 | a\\|b\\\\c | Pending |")
	})

	it("falls back to the raw status string when it is not in the status map", () => {
		// statusMap に無いステータス（想定外値）はそのまま表示される（実装 28 行の `|| item.status`）
		const todoList = [{ id: "1", content: "weird", status: "blocked" }] as unknown as TodoItem[]

		const result = formatReminderSection(todoList)

		expect(result).toContain("| 1 | weird | blocked |")
	})
})
