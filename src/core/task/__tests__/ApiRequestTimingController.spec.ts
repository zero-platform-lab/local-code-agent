import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { ApiRequestTimingController } from "../ApiRequestTimingController"

vi.mock("delay", () => ({ default: vi.fn(() => Promise.resolve()) }))

function makeController(opts: {
	stateRateLimit?: number
	hostRateLimit?: number
	requestDelaySeconds?: number
	lastRequestTime?: number
	abort?: boolean
	noProvider?: boolean
	sayImpl?: (...args: unknown[]) => Promise<void>
}) {
	const state = {
		requestDelaySeconds: opts.requestDelaySeconds,
		apiConfiguration: opts.stateRateLimit !== undefined ? { rateLimitSeconds: opts.stateRateLimit } : undefined,
	}
	const host = {
		taskId: "t1",
		abort: opts.abort ?? false,
		// hostRateLimit 未指定なら undefined（`?? 0` フォールバックを踏ませる）
		apiConfiguration: { rateLimitSeconds: opts.hostRateLimit },
		providerRef: {
			deref: () => (opts.noProvider ? undefined : { getState: vi.fn(async () => state) }),
		},
		say: opts.sayImpl ?? vi.fn(async () => {}),
	}
	const closures = { getLastGlobalApiRequestTime: vi.fn(() => opts.lastRequestTime) }
	return { controller: new ApiRequestTimingController(host as never, closures as never), host, closures }
}

beforeEach(() => {
	// 経過時間を 0 に固定して rateLimitDelay がフルに出るようにする
	vi.spyOn(performance, "now").mockReturnValue(1000)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("ApiRequestTimingController.maybeWaitForRateLimit", () => {
	it("rateLimit 0 なら何もしない", async () => {
		const { controller, host } = makeController({ stateRateLimit: 0, lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(0)

		expect(host.say).not.toHaveBeenCalled()
	})

	it("lastRequestTime が無ければ何もしない", async () => {
		const { controller, host } = makeController({ stateRateLimit: 3, lastRequestTime: undefined })

		await controller.maybeWaitForRateLimit(0)

		expect(host.say).not.toHaveBeenCalled()
	})

	it("retryAttempt=0 でディレイ有りならカウントダウン say を出し最後に確定 say する", async () => {
		const { controller, host } = makeController({ stateRateLimit: 3, lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(0)

		// 3,2,1 の partial + 確定の非 partial = 4 回
		expect(host.say).toHaveBeenCalledTimes(4)
		expect(host.say).toHaveBeenNthCalledWith(
			1,
			"api_req_rate_limit_wait",
			JSON.stringify({ seconds: 3 }),
			undefined,
			true,
		)
		expect(host.say).toHaveBeenLastCalledWith("api_req_rate_limit_wait", undefined, undefined, false)
	})

	it("retryAttempt>0 ではカウントダウン UX を出さない", async () => {
		const { controller, host } = makeController({ stateRateLimit: 3, lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(1)

		expect(host.say).not.toHaveBeenCalled()
	})

	it("state の rateLimit が host.apiConfiguration より優先される", async () => {
		const { controller, host } = makeController({ stateRateLimit: 2, hostRateLimit: 9, lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(0)

		// state 側 2 秒 → 2,1 の partial + 確定 = 3 回（host 側 9 秒ではない）
		expect(host.say).toHaveBeenCalledTimes(3)
	})

	it("provider が無ければ host.apiConfiguration の rateLimit を使う", async () => {
		const { controller, host } = makeController({ noProvider: true, hostRateLimit: 2, lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(0)

		expect(host.say).toHaveBeenCalledTimes(3)
	})

	it("state・host どちらの rateLimit も未指定なら 0 扱いで何もしない", async () => {
		const { controller, host } = makeController({ lastRequestTime: 1000 })

		await controller.maybeWaitForRateLimit(0)

		expect(host.say).not.toHaveBeenCalled()
	})
})

describe("ApiRequestTimingController.backoffAndAnnounce", () => {
	it("指数バックオフのカウントダウンを出す（baseDelay 既定 5）", async () => {
		const { controller, host } = makeController({})

		await controller.backoffAndAnnounce(0, { message: "boom" })

		// 5,4,3,2,1 の partial + 確定 = 6 回
		expect(host.say).toHaveBeenCalledTimes(6)
		expect(host.say).toHaveBeenNthCalledWith(
			1,
			"api_req_retry_delayed",
			"boom\n<retry_timer>5</retry_timer>",
			undefined,
			true,
		)
	})

	it("error.status があればヘッダに status と message を含める", async () => {
		const { controller, host } = makeController({ requestDelaySeconds: 1 })

		await controller.backoffAndAnnounce(0, { status: 500, message: "server" })

		expect(host.say).toHaveBeenNthCalledWith(
			1,
			"api_req_retry_delayed",
			"500\nserver\n<retry_timer>1</retry_timer>",
			undefined,
			true,
		)
	})

	it("status も message も無ければ Unknown error", async () => {
		const { controller, host } = makeController({ requestDelaySeconds: 1 })

		await controller.backoffAndAnnounce(0, {})

		expect(host.say).toHaveBeenNthCalledWith(
			1,
			"api_req_retry_delayed",
			"Unknown error\n<retry_timer>1</retry_timer>",
			undefined,
			true,
		)
	})

	it("finalDelay が 0 以下なら早期 return（requestDelaySeconds が負）", async () => {
		const { controller, host } = makeController({ requestDelaySeconds: -3 })

		await controller.backoffAndAnnounce(0, { message: "x" })

		expect(host.say).not.toHaveBeenCalled()
	})

	it("カウントダウン中に abort されたら say せず握り潰して return する", async () => {
		const { controller, host } = makeController({ abort: true, requestDelaySeconds: 1 })
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await controller.backoffAndAnnounce(0, { message: "boom" })

		// 最初の反復で abort チェックが throw → catch で握り潰す
		expect(host.say).not.toHaveBeenCalled()
		expect(errSpy).not.toHaveBeenCalled()
	})

	it("status はあるが message が無ければヘッダは status + Unknown error", async () => {
		const { controller, host } = makeController({ requestDelaySeconds: 1 })

		await controller.backoffAndAnnounce(0, { status: 500 })

		expect(host.say).toHaveBeenNthCalledWith(
			1,
			"api_req_retry_delayed",
			"500\nUnknown error\n<retry_timer>1</retry_timer>",
			undefined,
			true,
		)
	})

	it("countdown 中に非 abort エラーが出たら console.error で記録する（握り潰さない）", async () => {
		// say が Error 以外を throw → catch の String(err) 経路 & abort=false で console.error
		const boom = "non-error failure"
		const { controller, host } = makeController({
			requestDelaySeconds: 1,
			sayImpl: vi.fn(async () => {
				throw boom
			}),
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await controller.backoffAndAnnounce(0, { message: "boom" })

		expect(errSpy).toHaveBeenCalledWith("Exponential backoff failed:", boom)
		expect(host.say).toHaveBeenCalledTimes(1)
	})

	it("rateLimit 窓が指数ディレイより長ければ rateLimitDelay を採用する", async () => {
		const { controller, host } = makeController({
			requestDelaySeconds: 1,
			stateRateLimit: 8,
			lastRequestTime: 1000,
		})

		await controller.backoffAndAnnounce(0, { message: "boom" })

		// exp=1 vs rateLimit=8 → max=8 → 8 partial + 確定 = 9 回
		expect(host.say).toHaveBeenCalledTimes(9)
	})
})
