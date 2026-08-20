// npx vitest run utils/__tests__/globalContext.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

const { getSettingsDirectoryPathMock } = vi.hoisted(() => ({
	getSettingsDirectoryPathMock: vi.fn(async (p: string) => `${p}/settings`),
}))

vi.mock("../storage", () => ({
	getSettingsDirectoryPath: getSettingsDirectoryPathMock,
}))

import { ensureSettingsDirectoryExists } from "../globalContext"

describe("ensureSettingsDirectoryExists", () => {
	beforeEach(() => {
		getSettingsDirectoryPathMock.mockClear()
	})

	it("globalStorageUri.fsPath を getSettingsDirectoryPath に渡し、その結果を返す", async () => {
		const context = {
			globalStorageUri: { fsPath: "/global/storage" },
		} as unknown as import("vscode").ExtensionContext

		const result = await ensureSettingsDirectoryExists(context)

		expect(getSettingsDirectoryPathMock).toHaveBeenCalledWith("/global/storage")
		expect(result).toBe("/global/storage/settings")
	})
})
