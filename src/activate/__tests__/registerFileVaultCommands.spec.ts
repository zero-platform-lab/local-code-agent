// npx vitest run activate/__tests__/registerFileVaultCommands.spec.ts
//
// File Vault のコマンド登録。
//
// 固定するのは 3 点。
//   1. 宣言した 5 つが 1 度ずつ登録されること
//   2. Disposable が全部 subscriptions に載ること＝ deactivate で解除されること
//   3. 有効化と全消去は、呼ばれた時点の対応表を渡すこと

import type * as vscode from "vscode"

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _callback: unknown) => ({ dispose: vi.fn() })),
}))

vi.mock("vscode", () => ({ commands: { registerCommand: mocks.registerCommand } }))

import { Package } from "../../shared/package"

import { registerFileVaultCommands } from "../registerFileVaultCommands"

function fakeController() {
	return {
		enable: vi.fn(async () => undefined),
		disable: vi.fn(async () => undefined),
		status: vi.fn(async () => undefined),
		clearSelected: vi.fn(async () => undefined),
		clearAll: vi.fn(async () => undefined),
	}
}

const vault = {} as never

const setup = () => {
	const subscriptions: { dispose: () => void }[] = []
	const controller = fakeController()
	const getVault = vi.fn(() => vault)
	registerFileVaultCommands(
		{ subscriptions } as unknown as vscode.ExtensionContext,
		controller as never,
		getVault as never,
	)
	const handlerFor = (id: string) =>
		mocks.registerCommand.mock.calls.find(
			([name]) => name === `${Package.name}.${id}`,
		)?.[1] as () => Promise<unknown>
	return { subscriptions, controller, getVault, handlerFor }
}

beforeEach(() => vi.clearAllMocks())

describe("registerFileVaultCommands", () => {
	it("5 つのコマンドを 1 度ずつ登録する", () => {
		setup()
		expect(mocks.registerCommand.mock.calls.map(([id]) => id)).toEqual([
			`${Package.name}.enableFileVault`,
			`${Package.name}.disableFileVault`,
			`${Package.name}.fileVaultStatus`,
			`${Package.name}.clearSelectedFileVault`,
			`${Package.name}.clearAllFileVault`,
		])
	})

	it("Disposable が全部 subscriptions に載る", () => {
		const { subscriptions } = setup()
		expect(subscriptions).toHaveLength(5)
	})

	it("有効化と全消去は、呼ばれた時点の対応表を渡す", async () => {
		const { controller, getVault, handlerFor } = setup()
		await handlerFor("enableFileVault")()
		await handlerFor("clearAllFileVault")()
		expect(controller.enable).toHaveBeenCalledWith(vault)
		expect(controller.clearAll).toHaveBeenCalledWith(vault)
		expect(getVault).toHaveBeenCalledTimes(2)
	})

	it("無効化・状態・選んで消去は、対応表を要らない", async () => {
		const { controller, handlerFor } = setup()
		await handlerFor("disableFileVault")()
		await handlerFor("fileVaultStatus")()
		await handlerFor("clearSelectedFileVault")()
		expect(controller.disable).toHaveBeenCalledOnce()
		expect(controller.status).toHaveBeenCalledOnce()
		expect(controller.clearSelected).toHaveBeenCalledOnce()
	})
})
