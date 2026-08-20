// npx vitest run core/task/__tests__/TaskModeState.spec.ts

import { defaultModeSlug } from "../../../shared/modes"

import { TaskModeState, type TaskModeStateProvider } from "../TaskModeState"

const makeProvider = (state: unknown = {}): TaskModeStateProvider & { getState: ReturnType<typeof vi.fn> } => ({
	getState: vi.fn(async () => state as any),
	log: vi.fn(),
})

describe("TaskModeState.fromHistoryItem", () => {
	it("takes mode / apiConfigName straight from the history item", async () => {
		const state = TaskModeState.fromHistoryItem({ mode: "architect", apiConfigName: "profile-a" })

		expect(state.mode).toBe("architect")
		expect(state.apiConfigName).toBe("profile-a")
		await expect(state.getMode()).resolves.toBe("architect")
		await expect(state.getApiConfigName()).resolves.toBe("profile-a")
	})

	it("falls back to the default mode when the history item has none", () => {
		expect(TaskModeState.fromHistoryItem({}).mode).toBe(defaultModeSlug)
	})

	it("keeps apiConfigName undefined for legacy history items", () => {
		// 旧タスクは apiConfigName を永続化していないので undefined のまま（throw しない）。
		expect(TaskModeState.fromHistoryItem({ mode: "code" }).apiConfigName).toBeUndefined()
	})

	it("resolves readiness immediately", async () => {
		const state = TaskModeState.fromHistoryItem({ mode: "code" })

		await expect(Promise.all([state.modeReady, state.apiConfigReady])).resolves.toBeDefined()
	})
})

describe("TaskModeState.fromProvider", () => {
	it("starts undefined and resolves from provider state", async () => {
		const provider = makeProvider({ mode: "debug", currentApiConfigName: "profile-b" })
		const state = TaskModeState.fromProvider(provider)

		expect(state.mode).toBeUndefined()
		expect(state.apiConfigName).toBeUndefined()

		await state.modeReady
		await state.apiConfigReady

		expect(state.mode).toBe("debug")
		expect(state.apiConfigName).toBe("profile-b")
	})

	it("falls back to defaults when provider state is empty", async () => {
		const state = TaskModeState.fromProvider(makeProvider({}))

		await state.modeReady
		await state.apiConfigReady

		expect(state.mode).toBe(defaultModeSlug)
		expect(state.apiConfigName).toBe("default")
	})

	it("falls back and logs when provider.getState() rejects", async () => {
		const provider = makeProvider()
		provider.getState.mockRejectedValue(new Error("nope"))
		const state = TaskModeState.fromProvider(provider)

		await state.modeReady
		await state.apiConfigReady

		expect(state.mode).toBe(defaultModeSlug)
		expect(state.apiConfigName).toBe("default")
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Failed to initialize task mode: nope"))
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to initialize task API config name: nope"),
		)
	})

	it("getState が Error 以外を投げても String 化してログする（mode / apiConfigName 両方）", async () => {
		const provider = makeProvider()
		provider.getState.mockRejectedValue("plain string failure")
		const state = TaskModeState.fromProvider(provider)

		await state.modeReady
		await state.apiConfigReady

		expect(state.mode).toBe(defaultModeSlug)
		expect(state.apiConfigName).toBe("default")
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to initialize task mode: plain string failure"),
		)
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to initialize task API config name: plain string failure"),
		)
	})

	it("does not clobber an apiConfigName set while provider state is pending", async () => {
		let resolveState: ((value: unknown) => void) | undefined
		// mode / apiConfigName の初期化が同じ getState 呼び出しを共有する形（実 provider と同じ）。
		const pending = new Promise<any>((resolve) => (resolveState = resolve))
		const provider: TaskModeStateProvider = { getState: vi.fn(() => pending), log: vi.fn() }
		const state = TaskModeState.fromProvider(provider)

		// ユーザーが task 作成直後に profile を切り替えたケース。
		state.apiConfigName = "new-profile"
		resolveState?.({ currentApiConfigName: "old-profile" })
		await state.apiConfigReady

		expect(state.apiConfigName).toBe("new-profile")
	})

	it("does not clobber an apiConfigName set before a rejected provider state", async () => {
		let rejectState: ((error: unknown) => void) | undefined
		const pending = new Promise<any>((_resolve, reject) => (rejectState = reject))
		const provider: TaskModeStateProvider = { getState: vi.fn(() => pending), log: vi.fn() }
		const state = TaskModeState.fromProvider(provider)

		state.apiConfigName = "new-profile"
		rejectState?.(new Error("nope"))
		await state.apiConfigReady

		expect(state.apiConfigName).toBe("new-profile")
	})

	it("lets a later mode write win over the pending initialization result", async () => {
		// mode 側は clobber 保護がない（既存動作）ので、初期化が後から上書きする。
		let resolveState: ((value: unknown) => void) | undefined
		const pending = new Promise<any>((resolve) => (resolveState = resolve))
		const provider: TaskModeStateProvider = { getState: vi.fn(() => pending), log: vi.fn() }
		const state = TaskModeState.fromProvider(provider)

		state.mode = "architect"
		resolveState?.({ mode: "debug" })
		await state.modeReady

		expect(state.mode).toBe("debug")
	})
})

describe("TaskModeState.requireMode", () => {
	it("throws while the mode is still uninitialized", () => {
		const state = TaskModeState.fromProvider(makeProvider({ mode: "code" }))

		expect(() => state.requireMode()).toThrow(/Task mode accessed before initialization/)
	})

	it("returns the mode once initialized", async () => {
		const state = TaskModeState.fromProvider(makeProvider({ mode: "code" }))
		await state.modeReady

		expect(state.requireMode()).toBe("code")
	})
})

describe("TaskModeState.getMode", () => {
	it("falls back to the default mode when the value stays undefined", async () => {
		const state = TaskModeState.fromHistoryItem({ mode: "code" })
		state.mode = undefined

		await expect(state.getMode()).resolves.toBe(defaultModeSlug)
	})
})
