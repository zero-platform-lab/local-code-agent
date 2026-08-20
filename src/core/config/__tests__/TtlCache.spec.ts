// npx vitest run core/config/__tests__/TtlCache.spec.ts

import { TtlCache } from "../TtlCache"

const withClock = <T>(ttlMs: number) => {
	let now = 1_000
	const cache = new TtlCache<T>(ttlMs, () => now)
	return { cache, advance: (ms: number) => (now += ms) }
}

describe("TtlCache", () => {
	it("returns undefined before anything is stored", () => {
		expect(withClock<string>(100).cache.get()).toBeUndefined()
	})

	it("returns the stored value while it is fresh", () => {
		const { cache, advance } = withClock<string>(100)
		cache.set("v")
		advance(99)

		expect(cache.get()).toBe("v")
	})

	it("expires exactly at the TTL boundary", () => {
		const { cache, advance } = withClock<string>(100)
		cache.set("v")
		advance(100)

		expect(cache.get()).toBeUndefined()
	})

	it("stays expired past the boundary", () => {
		const { cache, advance } = withClock<string>(100)
		cache.set("v")
		advance(1_000)

		expect(cache.get()).toBeUndefined()
	})

	it("restarts the clock on every set", () => {
		const { cache, advance } = withClock<string>(100)
		cache.set("first")
		advance(90)
		cache.set("second")
		advance(90)

		expect(cache.get()).toBe("second")
	})

	it("drops the value on clear even while fresh", () => {
		const { cache } = withClock<string>(100)
		cache.set("v")
		cache.clear()

		expect(cache.get()).toBeUndefined()
	})

	it("caches falsy values without treating them as a miss", () => {
		// モードが 0 件（空配列）でもキャッシュヒットとして扱われる必要がある。
		const { cache } = withClock<string[]>(100)
		cache.set([])

		expect(cache.get()).toEqual([])
	})

	it("follows Date.now even when it is replaced after construction", () => {
		// 既定の時計は `Date.now` を束縛せず毎回引く。CustomModesManager.spec の TTL テストは
		// manager を作った後で Date.now を差し替えるので、束縛すると期限切れを検知できない。
		const originalDateNow = Date.now
		try {
			const cache = new TtlCache<string>(100)
			let currentTime = 1_000
			Date.now = vi.fn(() => currentTime)

			cache.set("v")
			expect(cache.get()).toBe("v")

			currentTime += 1_000
			expect(cache.get()).toBeUndefined()
		} finally {
			Date.now = originalDateNow
		}
	})

	it("can be re-populated after clear", () => {
		const { cache } = withClock<string>(100)
		cache.set("a")
		cache.clear()
		cache.set("b")

		expect(cache.get()).toBe("b")
	})
})
