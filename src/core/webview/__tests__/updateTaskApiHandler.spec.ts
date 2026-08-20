import { describe, it, expect, vi } from "vitest"

import type { ProviderSettings } from "@openai-agent/types"

import { updateTaskApiHandlerIfNeeded, type ApiHandlerSyncTask } from "../updateTaskApiHandler"

const settings = (overrides: Partial<ProviderSettings> = {}): ProviderSettings =>
	({
		apiProvider: "openai",
		openAiModelId: "gpt-4o",
		...overrides,
	}) as ProviderSettings

const makeTask = (apiConfiguration?: ProviderSettings) => {
	const task: ApiHandlerSyncTask = {
		apiConfiguration,
		updateApiConfiguration: vi.fn(),
	}
	return task
}

describe("updateTaskApiHandlerIfNeeded", () => {
	it("現在タスクが無ければ何もしない", () => {
		expect(() => updateTaskApiHandlerIfNeeded(undefined, settings())).not.toThrow()
	})

	it("provider が変わったら API ハンドラを再構築する", () => {
		const next = settings({ apiProvider: "anthropic" as ProviderSettings["apiProvider"] })
		const task = makeTask(settings())

		updateTaskApiHandlerIfNeeded(task, next)

		expect(task.updateApiConfiguration).toHaveBeenCalledWith(next)
	})

	it("model が変わったら API ハンドラを再構築する", () => {
		const next = settings({ openAiModelId: "gpt-4o-mini" })
		const task = makeTask(settings())

		updateTaskApiHandlerIfNeeded(task, next)

		expect(task.updateApiConfiguration).toHaveBeenCalledWith(next)
	})

	it("provider も model も同じなら apiConfiguration の同期だけ行う", () => {
		const next = settings({ openAiBaseUrl: "https://example.test" } as Partial<ProviderSettings>)
		const task = makeTask(settings())

		updateTaskApiHandlerIfNeeded(task, next)

		expect(task.updateApiConfiguration).not.toHaveBeenCalled()
		expect(task.apiConfiguration).toBe(next)
	})

	it("forceRebuild なら provider/model が同じでも再構築する", () => {
		const next = settings()
		const task = makeTask(settings())

		updateTaskApiHandlerIfNeeded(task, next, { forceRebuild: true })

		expect(task.updateApiConfiguration).toHaveBeenCalledWith(next)
	})

	it("以前の設定が無ければ（初回）再構築する", () => {
		const next = settings()
		const task = makeTask(undefined)

		updateTaskApiHandlerIfNeeded(task, next)

		expect(task.updateApiConfiguration).toHaveBeenCalledWith(next)
	})
})
