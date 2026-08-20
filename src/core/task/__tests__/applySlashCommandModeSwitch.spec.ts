import { describe, it, expect, vi, beforeEach } from "vitest"

import { applySlashCommandModeSwitch } from "../applySlashCommandModeSwitch"

vi.mock("../../../shared/modes", () => ({ getModeBySlug: vi.fn() }))

import { getModeBySlug } from "../../../shared/modes"

const mockedGetMode = vi.mocked(getModeBySlug)

function makeProvider(customModes: unknown[] = []) {
	return {
		getState: vi.fn(async () => ({ customModes })),
		handleModeSwitch: vi.fn(async () => {}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedGetMode.mockReturnValue({ slug: "code" } as never)
})

describe("applySlashCommandModeSwitch", () => {
	it("slashCommandMode が無ければ何もしない（getState も呼ばない）", async () => {
		const provider = makeProvider()

		await applySlashCommandModeSwitch(provider as never, undefined)

		expect(provider.getState).not.toHaveBeenCalled()
		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
	})

	it("provider が無ければ何もしない", async () => {
		await applySlashCommandModeSwitch(undefined, "code")

		expect(mockedGetMode).not.toHaveBeenCalled()
	})

	it("指定モードが存在しなければ切り替えない", async () => {
		mockedGetMode.mockReturnValue(undefined as never)
		const provider = makeProvider()

		await applySlashCommandModeSwitch(provider as never, "ghost")

		expect(provider.getState).toHaveBeenCalledTimes(1)
		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
	})

	it("存在するモードなら getState の customModes で解決して handleModeSwitch する", async () => {
		const customModes = [{ slug: "code" }]
		const provider = makeProvider(customModes)

		await applySlashCommandModeSwitch(provider as never, "code")

		expect(mockedGetMode).toHaveBeenCalledWith("code", customModes)
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("code")
	})
})
