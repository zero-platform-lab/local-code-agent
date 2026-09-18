// npx vitest core/ignore/__tests__/AgentIgnoreController.mappingStore.spec.ts

import { AgentIgnoreController, isInsideMappingStore, setMappingStorageRoot } from "../AgentIgnoreController"

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
		},
		RelativePattern: vi.fn().mockImplementation((base: unknown, pattern: unknown) => ({ base, pattern })),
	}
})

describe("対応表の保管領域はエージェントのファイルツールから隠す", () => {
	afterEach(() => setMappingStorageRoot(undefined))

	it("isInsideMappingStore は保管ルート配下だけを true にする", () => {
		setMappingStorageRoot({ fsPath: "/w/.pii" } as never)
		expect(isInsideMappingStore("/w/.pii")).toBe(true)
		expect(isInsideMappingStore("/w/.pii/file-mapping.v1.json")).toBe(true)
		expect(isInsideMappingStore("/w/other.md")).toBe(false)
		// 区切り境界で照合するので、名前が前方一致するだけの別ディレクトリは誤爆しない。
		expect(isInsideMappingStore("/w/.pii-other/x")).toBe(false)
	})

	it("ルート未設定なら常に false", () => {
		setMappingStorageRoot(undefined)
		expect(isInsideMappingStore("/w/.pii/file-mapping.v1.json")).toBe(false)
	})

	it("validateAccess は .agentignore が無くても保管領域を拒否する（対応表がモデルへ渡らない）", () => {
		const controller = new AgentIgnoreController("/w")
		// initialize を呼ばないので rooIgnoreContent は undefined（通常なら全許可）。
		setMappingStorageRoot({ fsPath: "/w/.pii" } as never)
		expect(controller.validateAccess(".pii/file-mapping.v1.json")).toBe(false)
		expect(controller.validateAccess("src/app.ts")).toBe(true)
	})
})
