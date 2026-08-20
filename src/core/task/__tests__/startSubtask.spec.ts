import { describe, it, expect, vi } from "vitest"

import { startSubtask } from "../startSubtask"

describe("startSubtask", () => {
	it("provider が deref できれば delegateParentAndOpenChild に引数をそのまま渡し、戻り値を返す", async () => {
		const delegateParentAndOpenChild = vi.fn((..._a: unknown[]) => Promise.resolve("CHILD"))
		const provider = { delegateParentAndOpenChild }
		const providerRef = { deref: () => provider } as never
		const todos = [{ id: "1", content: "todo", status: "pending" }] as never

		const result = await startSubtask(providerRef, "parent-1", "msg", todos, "code")

		expect(delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: "msg",
			initialTodos: todos,
			mode: "code",
		})
		expect(result).toBe("CHILD")
	})

	it("provider が deref できなければ Provider not available を投げる", async () => {
		const providerRef = { deref: () => undefined } as never

		await expect(startSubtask(providerRef, "p", "m", [], "code")).rejects.toThrow("Provider not available")
	})
})
