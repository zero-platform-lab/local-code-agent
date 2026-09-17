// npx vitest run activate/__tests__/registerFileVaultCommands.spec.ts
//
// File Vault の消去コマンドの登録。
//
// 固定するのは 3 点。
//   1. 宣言した 2 つが 1 度ずつ登録されること
//   2. Disposable が全部 subscriptions に載ること＝ deactivate で解除されること
//   3. 全消去は、呼ばれた時点の対応表を渡すこと（会話と同じ番号の場所を使う）

import type * as vscode from "vscode"

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _callback: unknown) => ({ dispose: vi.fn() })),
}))

vi.mock("vscode", () => ({ commands: { registerCommand: mocks.registerCommand } }))

import { Package } from "../../shared/package"

import { registerFileVaultCommands } from "../registerFileVaultCommands"

function fakeController() {
	return {
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
	it("2 つのコマンドを 1 度ずつ登録する", () => {
		setup()
		expect(mocks.registerCommand.mock.calls.map(([id]) => id)).toEqual([
			`${Package.name}.clearSelectedFileVault`,
			`${Package.name}.clearAllFileVault`,
		])
	})

	it("Disposable が全部 subscriptions に載る", () => {
		expect(setup().subscriptions).toHaveLength(2)
	})

	it("選んで消去は、対応表を要らない", async () => {
		const { controller, handlerFor } = setup()
		await handlerFor("clearSelectedFileVault")()
		expect(controller.clearSelected).toHaveBeenCalledOnce()
	})

	it("全消去は、呼ばれた時点の対応表を渡す", async () => {
		const { controller, getVault, handlerFor } = setup()
		await handlerFor("clearAllFileVault")()
		expect(controller.clearAll).toHaveBeenCalledWith(vault)
		expect(getVault).toHaveBeenCalledOnce()
	})
})
