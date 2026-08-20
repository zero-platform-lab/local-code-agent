import { describe, it, expect, vi, afterEach } from "vitest"
import crypto from "crypto"
import {
	parseMarkdownChecklist,
	updateTodoListTool,
	addTodoToTask,
	updateTodoStatusForTask,
	removeTodoFromTask,
	getTodoListForTask,
	setTodoListForTask,
	restoreTodoListForTask,
	setPendingTodoList,
	validateTodos,
} from "../UpdateTodoListTool"
import { formatResponse } from "../../prompts/responses"
import type { ToolUse } from "../../../shared/tools"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

describe("parseMarkdownChecklist", () => {
	describe("standard checkbox format (without dash prefix)", () => {
		it("should parse pending tasks", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with lowercase x", () => {
			const md = `[x] Completed task 1
[x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with uppercase X", () => {
			const md = `[X] Completed task 1
[X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash", () => {
			const md = `[-] In progress task 1
[-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with tilde", () => {
			const md = `[~] In progress task 1
[~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("dash-prefixed checkbox format", () => {
		it("should parse pending tasks with dash prefix", () => {
			const md = `- [ ] Task 1
- [ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with dash prefix and lowercase x", () => {
			const md = `- [x] Completed task 1
- [x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with dash prefix and uppercase X", () => {
			const md = `- [X] Completed task 1
- [X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash prefix and dash marker", () => {
			const md = `- [-] In progress task 1
- [-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with dash prefix and tilde marker", () => {
			const md = `- [~] In progress task 1
- [~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("mixed formats", () => {
		it("should parse mixed formats correctly", () => {
			const md = `[ ] Task without dash
- [ ] Task with dash
[x] Completed without dash
- [X] Completed with dash
[-] In progress without dash
- [~] In progress with dash`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(6)

			expect(result[0].content).toBe("Task without dash")
			expect(result[0].status).toBe("pending")

			expect(result[1].content).toBe("Task with dash")
			expect(result[1].status).toBe("pending")

			expect(result[2].content).toBe("Completed without dash")
			expect(result[2].status).toBe("completed")

			expect(result[3].content).toBe("Completed with dash")
			expect(result[3].status).toBe("completed")

			expect(result[4].content).toBe("In progress without dash")
			expect(result[4].status).toBe("in_progress")

			expect(result[5].content).toBe("In progress with dash")
			expect(result[5].status).toBe("in_progress")
		})
	})

	describe("edge cases", () => {
		it("should handle empty strings", () => {
			const result = parseMarkdownChecklist("")
			expect(result).toEqual([])
		})

		it("should handle non-string input", () => {
			const result = parseMarkdownChecklist(null as any)
			expect(result).toEqual([])
		})

		it("should handle undefined input", () => {
			const result = parseMarkdownChecklist(undefined as any)
			expect(result).toEqual([])
		})

		it("should ignore non-checklist lines", () => {
			const md = `This is not a checklist
[ ] Valid task
Just some text
- Not a checklist item
- [x] Valid completed task
[not valid] Invalid format`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Valid task")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Valid completed task")
			expect(result[1].status).toBe("completed")
		})

		it("should handle extra spaces", () => {
			const md = `  [ ]   Task with spaces  
-  [ ]  Task with dash and spaces
  [x]  Completed with spaces
-   [X]   Completed with dash and spaces`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(4)
			expect(result[0].content).toBe("Task with spaces")
			expect(result[1].content).toBe("Task with dash and spaces")
			expect(result[2].content).toBe("Completed with spaces")
			expect(result[3].content).toBe("Completed with dash and spaces")
		})

		it("should handle Windows line endings", () => {
			const md = "[ ] Task 1\r\n- [x] Task 2\r\n[-] Task 3"
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(3)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("completed")
			expect(result[2].content).toBe("Task 3")
			expect(result[2].status).toBe("in_progress")
		})
	})

	describe("ID generation", () => {
		it("should generate consistent IDs for the same content and status", () => {
			const md1 = `[ ] Task 1
[x] Task 2`
			const md2 = `[ ] Task 1
[x] Task 2`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)

			expect(result1[0].id).toBe(result2[0].id)
			expect(result1[1].id).toBe(result2[1].id)
		})

		it("should generate different IDs for different content", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate different IDs for same content but different status", () => {
			const md = `[ ] Task 1
[x] Task 1`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate same IDs regardless of dash prefix", () => {
			const md1 = `[ ] Task 1`
			const md2 = `- [ ] Task 1`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)
			expect(result1[0].id).toBe(result2[0].id)
		})
	})
})

// ---------------------------------------------------------------------------
// execute / handlePartial / helpers
//
// updateTodoList は承認を挟んで Task.todoList を書き換えるツール。ここで守るのは
// 「承認前に確定させない」「承認ダイアログ中にユーザが編集したらその編集を採用する」
// 「壊れた入力でクラッシュせずエラーを返す」こと。
// ---------------------------------------------------------------------------

function makeHost() {
	const host = makeMockTask() as any
	host.todoList = undefined
	return host
}

function makeCb(approve = true) {
	return {
		askApproval: vi.fn(async () => approve),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(() => {}),
	}
}

describe("UpdateTodoListTool.execute", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		setPendingTodoList(undefined as any)
	})

	it("承認され、編集が無ければリストを更新して成功文を返す", async () => {
		const host = makeHost()
		const cb = makeCb(true)
		host.mistakeTracker.count = 2

		// pending / in_progress / completed の 3 状態を通して normalizeStatus を網羅する。
		await updateTodoListTool.execute({ todos: "[ ] P\n[-] I\n[x] C" }, host, cb as any)

		expect(cb.pushToolResult).toHaveBeenCalledWith(formatResponse.toolResult("Todo list updated successfully."))
		expect(host.todoList).toHaveLength(3)
		expect(host.todoList.map((t: any) => t.status)).toEqual(["pending", "in_progress", "completed"])
		// user_edit は起きていない。
		expect(host.say).not.toHaveBeenCalledWith("user_edit_todos", expect.anything())
	})

	it("空の todos は「リストを空にする」有効な操作として通る", async () => {
		const host = makeHost()
		const cb = makeCb(true)

		await updateTodoListTool.execute({ todos: "" }, host, cb as any)

		expect(host.todoList).toEqual([])
		expect(cb.pushToolResult).toHaveBeenCalledWith(formatResponse.toolResult("Todo list updated successfully."))
	})

	it("不変条件：承認されなければ todoList を書き換えない", async () => {
		const host = makeHost()
		host.todoList = [{ id: "keep", content: "既存", status: "pending" }]
		const cb = makeCb(false)

		await updateTodoListTool.execute({ todos: "[ ] New" }, host, cb as any)

		// 元のリストがそのまま残っている（setTodoListForTask に到達していない）。
		expect(host.todoList).toEqual([{ id: "keep", content: "既存", status: "pending" }])
		expect(cb.pushToolResult).toHaveBeenCalledWith("User declined to update the todoList.")
	})

	it("承認ダイアログ中にユーザが編集したら、その編集後リストを採用する", async () => {
		const host = makeHost()
		const edited = [
			{ id: "1", content: "P", status: "pending" },
			{ id: "2", content: "I", status: "in_progress" },
			{ id: "3", content: "C", status: "completed" },
		]
		// askApproval の裏で webview から setPendingTodoList が呼ばれる状況を再現。
		const cb = makeCb(true)
		cb.askApproval = vi.fn(async () => {
			setPendingTodoList(edited as any)
			return true
		})

		await updateTodoListTool.execute({ todos: "[ ] original" }, host, cb as any)

		expect(host.say).toHaveBeenCalledWith(
			"user_edit_todos",
			JSON.stringify({ tool: "updateTodoList", todos: edited }),
		)
		expect(host.todoList).toBe(edited)
		// markdown 化した編集結果が返る（3 状態すべてのボックス記号を含む）。
		expect(cb.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolResult("User edits todo:\n\n[ ] P\n[-] I\n[x] C"),
		)
	})

	it("承認中の編集が null でも空リストとして安全に採用する", async () => {
		// setPendingTodoList(null) は壊れた webview メッセージで起こりうる。?? [] に落ちる。
		const host = makeHost()
		const cb = makeCb(true)
		cb.askApproval = vi.fn(async () => {
			setPendingTodoList(null as any)
			return true
		})

		await updateTodoListTool.execute({ todos: "[ ] original" }, host, cb as any)

		expect(host.todoList).toEqual([])
		expect(host.say).toHaveBeenCalledWith("user_edit_todos", JSON.stringify({ tool: "updateTodoList", todos: [] }))
		expect(cb.pushToolResult).toHaveBeenCalledWith(formatResponse.toolResult("User edits todo:\n\n"))
	})

	it("parse が例外を投げたら markdown 不正エラーを返し、書き換えない", async () => {
		// parseMarkdownChecklist は通常 throw しないが、crypto 障害など想定外の失敗に備えた
		// 防御的 catch がある。crypto.createHash を throw させて経路を通す。
		vi.spyOn(crypto, "createHash").mockImplementation(() => {
			throw new Error("crypto down")
		})
		const host = makeHost()
		host.todoList = [{ id: "keep", content: "x", status: "pending" }]
		const cb = makeCb(true)

		await updateTodoListTool.execute({ todos: "[ ] X" }, host, cb as any)

		expect(cb.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("The todos parameter is not valid markdown checklist or JSON"),
		)
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("update_todo_list")
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(host.todoList).toEqual([{ id: "keep", content: "x", status: "pending" }])
	})

	it("検証に失敗する todos（id 欠落）はエラーを返し、書き換えない", async () => {
		// crypto の digest が空文字を返す＝id 欠落。validateTodos が invalid を返す経路を通す。
		vi.spyOn(crypto, "createHash").mockReturnValue({
			update: () => ({ digest: () => "" }),
		} as any)
		const host = makeHost()
		const cb = makeCb(true)

		await updateTodoListTool.execute({ todos: "[ ] X" }, host, cb as any)

		expect(cb.pushToolResult).toHaveBeenCalledWith(formatResponse.toolError("Item 1 is missing id"))
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(cb.askApproval).not.toHaveBeenCalled()
	})

	it("実行中の例外は handleError に委譲する", async () => {
		const host = makeHost()
		const boom = new Error("approval boom")
		const cb = makeCb(true)
		cb.askApproval = vi.fn(async () => {
			throw boom
		})

		await updateTodoListTool.execute({ todos: "[ ] X" }, host, cb as any)

		expect(cb.handleError).toHaveBeenCalledWith("update todo list", boom)
	})
})

describe("UpdateTodoListTool.handlePartial", () => {
	afterEach(() => vi.restoreAllMocks())

	function partial(todos?: string): ToolUse<"update_todo_list"> {
		return {
			type: "tool_use",
			name: "update_todo_list",
			params: todos === undefined ? {} : { todos },
			partial: true,
		}
	}

	it("パース済み todos を streaming 表示に載せる", async () => {
		const host = makeHost()
		const cb = makeCb()

		await updateTodoListTool.handle(host, partial("[ ] A"), cb as any)

		const [type, payload, isPartial] = host.ask.mock.calls[0]
		expect(type).toBe("tool")
		expect(isPartial).toBe(true)
		const parsed = JSON.parse(payload)
		expect(parsed.tool).toBe("updateTodoList")
		expect(parsed.todos[0].content).toBe("A")
	})

	it("todos 未指定でも空配列で表示する", async () => {
		const host = makeHost()
		const cb = makeCb()

		await updateTodoListTool.handle(host, partial(undefined), cb as any)

		expect(JSON.parse(host.ask.mock.calls[0][1]).todos).toEqual([])
	})

	it("parse が失敗しても空配列にフォールバックして表示する", async () => {
		vi.spyOn(crypto, "createHash").mockImplementation(() => {
			throw new Error("crypto down")
		})
		const host = makeHost()
		const cb = makeCb()

		await updateTodoListTool.handle(host, partial("[ ] A"), cb as any)

		expect(JSON.parse(host.ask.mock.calls[0][1]).todos).toEqual([])
	})

	it("task.ask が reject しても握りつぶして落ちない", async () => {
		const host = makeHost()
		host.ask = vi.fn().mockRejectedValue(new Error("ask boom"))
		const cb = makeCb()

		await expect(updateTodoListTool.handle(host, partial("[ ] A"), cb as any)).resolves.toBeUndefined()
	})
})

describe("addTodoToTask", () => {
	it("todoList が無ければ作ってから push し、既定は pending・自動 id", () => {
		const cline: any = {}
		const todo = addTodoToTask(cline, "内容")
		expect(cline.todoList).toHaveLength(1)
		expect(todo.status).toBe("pending")
		expect(typeof todo.id).toBe("string")
		expect(todo.id.length).toBeGreaterThan(0)
	})

	it("既存 todoList には追記し、status・id を指定できる", () => {
		const cline: any = { todoList: [{ id: "a", content: "先客", status: "pending" }] }
		const todo = addTodoToTask(cline, "内容2", "completed", "myid")
		expect(cline.todoList).toHaveLength(2)
		expect(todo).toEqual({ id: "myid", content: "内容2", status: "completed" })
	})
})

describe("updateTodoStatusForTask", () => {
	it("todoList が無ければ false", () => {
		expect(updateTodoStatusForTask({}, "x", "completed")).toBe(false)
	})

	it("該当 id が無ければ false", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "pending" }] }
		expect(updateTodoStatusForTask(cline, "zzz", "completed")).toBe(false)
	})

	it("pending→in_progress は許可される", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "pending" }] }
		expect(updateTodoStatusForTask(cline, "a", "in_progress")).toBe(true)
		expect(cline.todoList[0].status).toBe("in_progress")
	})

	it("in_progress→completed は許可される", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "in_progress" }] }
		expect(updateTodoStatusForTask(cline, "a", "completed")).toBe(true)
		expect(cline.todoList[0].status).toBe("completed")
	})

	it("同じ status への更新は許可される（冪等）", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "completed" }] }
		expect(updateTodoStatusForTask(cline, "a", "completed")).toBe(true)
	})

	it("不正な遷移（pending→completed）は拒否される", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "pending" }] }
		expect(updateTodoStatusForTask(cline, "a", "completed")).toBe(false)
		expect(cline.todoList[0].status).toBe("pending")
	})
})

describe("removeTodoFromTask", () => {
	it("todoList が無ければ false", () => {
		expect(removeTodoFromTask({}, "x")).toBe(false)
	})

	it("該当 id が無ければ false", () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "pending" }] }
		expect(removeTodoFromTask(cline, "zzz")).toBe(false)
		expect(cline.todoList).toHaveLength(1)
	})

	it("該当 id を削除して true", () => {
		const cline: any = {
			todoList: [
				{ id: "a", content: "c", status: "pending" },
				{ id: "b", content: "d", status: "pending" },
			],
		}
		expect(removeTodoFromTask(cline, "a")).toBe(true)
		expect(cline.todoList.map((t: any) => t.id)).toEqual(["b"])
	})
})

describe("getTodoListForTask", () => {
	it("todoList が無ければ undefined", () => {
		expect(getTodoListForTask({})).toBeUndefined()
	})

	it("あればコピーを返す（内部配列を露出しない）", () => {
		const list = [{ id: "a", content: "c", status: "pending" as const }]
		const cline: any = { todoList: list }
		const result = getTodoListForTask(cline)
		expect(result).toEqual(list)
		expect(result).not.toBe(list)
	})
})

describe("setTodoListForTask", () => {
	it("cline が undefined なら何もしない", async () => {
		await expect(setTodoListForTask(undefined, [])).resolves.toBeUndefined()
	})

	it("配列ならそのまま設定する", async () => {
		const cline: any = {}
		const todos = [{ id: "a", content: "c", status: "pending" as const }]
		await setTodoListForTask(cline, todos)
		expect(cline.todoList).toBe(todos)
	})

	it("配列でなければ空配列にする", async () => {
		const cline: any = { todoList: [{ id: "a", content: "c", status: "pending" }] }
		await setTodoListForTask(cline, undefined)
		expect(cline.todoList).toEqual([])
	})
})

describe("restoreTodoListForTask", () => {
	it("配列が渡されればそれを設定する", () => {
		const cline: any = { messageStore: { clineMessages: [] } }
		const todos = [{ id: "a", content: "c", status: "pending" as const }]
		restoreTodoListForTask(cline, todos)
		expect(cline.todoList).toBe(todos)
	})

	it("truthy だが配列でない値が来たら空配列にする", () => {
		const cline: any = { messageStore: { clineMessages: [] } }
		restoreTodoListForTask(cline, {} as any)
		expect(cline.todoList).toEqual([])
	})

	it("未指定なら履歴メッセージから最新 todo を復元する", () => {
		const clineMessages = [
			{
				type: "say",
				say: "user_edit_todos",
				text: JSON.stringify({
					tool: "updateTodoList",
					todos: [{ id: "h", content: "hist", status: "pending" }],
				}),
			},
		]
		const cline: any = { messageStore: { clineMessages } }
		restoreTodoListForTask(cline, undefined)
		expect(cline.todoList).toEqual([{ id: "h", content: "hist", status: "pending" }])
	})
})

describe("validateTodos", () => {
	it("配列でなければ invalid", () => {
		expect(validateTodos("nope" as any)).toEqual({ valid: false, error: "todos must be an array" })
	})

	it("要素がオブジェクトでなければ invalid", () => {
		expect(validateTodos([null as any])).toEqual({ valid: false, error: "Item 1 is not an object" })
	})

	it("id 欠落は invalid", () => {
		expect(validateTodos([{ content: "c", status: "pending" } as any])).toEqual({
			valid: false,
			error: "Item 1 is missing id",
		})
	})

	it("content 欠落は invalid", () => {
		expect(validateTodos([{ id: "a", status: "pending" } as any])).toEqual({
			valid: false,
			error: "Item 1 is missing content",
		})
	})

	it("不正な status は invalid", () => {
		expect(validateTodos([{ id: "a", content: "c", status: "bogus" } as any])).toEqual({
			valid: false,
			error: "Item 1 has invalid status",
		})
	})

	it("status 省略でも id・content があれば valid", () => {
		expect(validateTodos([{ id: "a", content: "c" } as any])).toEqual({ valid: true })
	})

	it("空配列は valid", () => {
		expect(validateTodos([])).toEqual({ valid: true })
	})
})
