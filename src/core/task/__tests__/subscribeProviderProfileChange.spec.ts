// npx vitest run core/task/__tests__/subscribeProviderProfileChange.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { AgentEventName } from "@openai-agent/types"

import { subscribeProviderProfileChange } from "../subscribeProviderProfileChange"

function makeHost() {
	return {
		taskId: "t1",
		instanceId: "i1",
		updateApiConfiguration: vi.fn(),
	}
}

/**
 * on() で登録された listener を掴むための provider mock。
 * deref() が返す実体を差し替えられるよう、providerRef も自前で組む。
 */
function setup(opts: { state?: unknown; getStateThrows?: boolean } = {}) {
	let captured: (() => Promise<void>) | undefined
	const provider = {
		on: vi.fn((_event: unknown, cb: () => Promise<void>) => {
			captured = cb
		}),
		off: vi.fn(),
		getState: vi.fn(async () => {
			if (opts.getStateThrows) throw new Error("state boom")
			return opts.state ?? {}
		}),
	}
	// deref() の戻りをテスト側で差し替えられる WeakRef 代替。
	let derefValue: unknown = provider
	const providerRef = { deref: () => derefValue } as never
	return {
		provider,
		providerRef,
		getListener: () => captured!,
		setDeref: (v: unknown) => {
			derefValue = v
		},
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("subscribeProviderProfileChange", () => {
	it("provider が on を持たなければ購読せず undefined を返す", () => {
		const host = makeHost()
		const providerRef = { deref: () => ({}) } as never

		expect(subscribeProviderProfileChange(host, providerRef)).toBeUndefined()
	})

	it("provider が deref できなければ undefined を返す", () => {
		const host = makeHost()
		const providerRef = { deref: () => undefined } as never

		expect(subscribeProviderProfileChange(host, providerRef)).toBeUndefined()
	})

	it("profile 変更で新しい apiConfiguration を反映する", async () => {
		const host = makeHost()
		const { provider, providerRef, getListener } = setup({ state: { apiConfiguration: { apiProvider: "openai" } } })

		const sub = subscribeProviderProfileChange(host, providerRef)
		expect(provider.on).toHaveBeenCalledWith(AgentEventName.ProviderProfileChanged, expect.any(Function))
		expect(sub?.label).toBe("provider.providerProfileChanged")

		await getListener()()

		expect(host.updateApiConfiguration).toHaveBeenCalledWith({ apiProvider: "openai" })
	})

	it("apiConfiguration が無ければ更新しない", async () => {
		const host = makeHost()
		const { providerRef, getListener } = setup({ state: {} })

		subscribeProviderProfileChange(host, providerRef)
		await getListener()()

		expect(host.updateApiConfiguration).not.toHaveBeenCalled()
	})

	it("listener 発火時に provider が GC 済みなら早期 return する", async () => {
		const host = makeHost()
		const { providerRef, getListener, setDeref } = setup({ state: { apiConfiguration: { x: 1 } } })

		subscribeProviderProfileChange(host, providerRef)
		// 購読後に provider が GC された状況を再現
		setDeref(undefined)
		await getListener()()

		expect(host.updateApiConfiguration).not.toHaveBeenCalled()
	})

	it("getState が投げても握り潰して console.error する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const host = makeHost()
		const { providerRef, getListener } = setup({ getStateThrows: true })

		subscribeProviderProfileChange(host, providerRef)
		await getListener()()

		expect(host.updateApiConfiguration).not.toHaveBeenCalled()
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to update API configuration"),
			expect.any(Error),
		)
		errSpy.mockRestore()
	})

	it("dispose で off を呼ぶ", () => {
		const host = makeHost()
		const { provider, providerRef } = setup()

		const sub = subscribeProviderProfileChange(host, providerRef)
		sub?.dispose()

		expect(provider.off).toHaveBeenCalledWith(AgentEventName.ProviderProfileChanged, expect.any(Function))
	})
})
