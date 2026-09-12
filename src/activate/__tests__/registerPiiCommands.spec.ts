// npx vitest run activate/__tests__/registerPiiCommands.spec.ts
//
// 機密情報の伏せ字のコマンド登録。
//
// 固定するのは 3 点。
//   1. 宣言した 3 つが 1 度だけ登録されること（二重登録は VS Code 側で例外になる）
//   2. Disposable が全部 subscriptions に載ること＝ deactivate で解除されること
//   3. **設定を呼ばれた時点で読むこと**。登録時に読むと、設定を変えても効かない

import type * as vscode from "vscode"

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _callback: unknown) => ({ dispose: vi.fn() })),
	maskSecretsInActiveEditor: vi.fn(async (..._args: unknown[]) => undefined),
	restoreSecretsInActiveEditor: vi.fn(async (..._args: unknown[]) => undefined),
	addSelectionToDictionary: vi.fn(async (..._args: unknown[]) => undefined),
	exportDictionary: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock("vscode", () => ({ commands: { registerCommand: mocks.registerCommand } }))

vi.mock("../../services/pii/maskEditor", () => ({
	maskSecretsInActiveEditor: mocks.maskSecretsInActiveEditor,
	restoreSecretsInActiveEditor: mocks.restoreSecretsInActiveEditor,
}))

vi.mock("../../services/pii/dictionaryEditor", () => ({
	addSelectionToDictionary: mocks.addSelectionToDictionary,
	exportDictionary: mocks.exportDictionary,
}))

import { Package } from "../../shared/package"

import { registerPiiCommands } from "../registerPiiCommands"

const setup = (settings: Record<string, unknown> = {}) => {
	const subscriptions: { dispose: () => void }[] = []
	const readSettings = vi.fn(() => settings)

	registerPiiCommands({ subscriptions } as unknown as vscode.ExtensionContext, readSettings)

	const handlerFor = (id: string) =>
		mocks.registerCommand.mock.calls.find(([name]) => name === `${Package.name}.${id}`)?.[1] as () => unknown

	return { subscriptions, readSettings, handlerFor }
}

beforeEach(() => vi.clearAllMocks())

describe("registerPiiCommands", () => {
	it("4 つのコマンドを 1 度ずつ登録する", () => {
		setup()

		expect(mocks.registerCommand.mock.calls.map(([id]) => id)).toEqual([
			`${Package.name}.maskSecretsInFile`,
			`${Package.name}.restoreSecretsInFile`,
			`${Package.name}.addToDictionary`,
			`${Package.name}.exportDictionary`,
		])
	})

	it("戻すコマンドは、いま動いているタスクの戻し方を使う（FR-PII-20a）", () => {
		const unmask = vi.fn((text: string) => text)
		const subscriptions: { dispose: () => void }[] = []
		registerPiiCommands(
			{ subscriptions } as unknown as vscode.ExtensionContext,
			() => ({}),
			() => unmask,
		)

		const handler = mocks.registerCommand.mock.calls.find(
			([name]) => name === `${Package.name}.restoreSecretsInFile`,
		)?.[1] as () => unknown
		handler()

		expect(mocks.restoreSecretsInActiveEditor).toHaveBeenCalledExactlyOnceWith(unmask)
	})

	it("会話が無ければ、戻し方を渡さない（FR-PII-20b）", () => {
		const { handlerFor } = setup()

		handlerFor("restoreSecretsInFile")()

		// 対応表が無いことは、戻す側が利用者へ伝える。
		expect(mocks.restoreSecretsInActiveEditor).toHaveBeenCalledExactlyOnceWith(undefined)
	})

	it("Disposable を全部 subscriptions へ載せる", () => {
		const { subscriptions } = setup()

		// deactivate で確実に解除されるようにする。
		expect(subscriptions).toHaveLength(4)
	})

	it.each([
		["maskSecretsInFile", () => mocks.maskSecretsInActiveEditor],
		["addToDictionary", () => mocks.addSelectionToDictionary],
		["exportDictionary", () => mocks.exportDictionary],
	])("%s は、呼ばれた時点の設定を渡す", (id, target) => {
		const settings = { dictionaryPaths: ["/w/dict.txt"] }
		const { readSettings, handlerFor } = setup(settings)

		// 登録の時点では読まない。読むと、設定を変えても効かない。
		expect(readSettings).not.toHaveBeenCalled()

		handlerFor(id)()

		expect(readSettings).toHaveBeenCalledOnce()
		expect(target()).toHaveBeenCalledExactlyOnceWith(settings)
	})
})
