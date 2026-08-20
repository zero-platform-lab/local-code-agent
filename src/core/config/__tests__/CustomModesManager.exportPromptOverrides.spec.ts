// npx vitest run core/config/__tests__/CustomModesManager.exportPromptOverrides.spec.ts

import type { Mock } from "vitest"

import * as path from "path"
import * as fs from "fs/promises"

import * as yaml from "yaml"
import * as vscode from "vscode"

import type { ModeConfig, PromptComponent } from "@openai-agent/types"

import { fileExistsAtPath } from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { GlobalFileNames } from "../../../shared/globalFileNames"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn(),
		createFileSystemWatcher: vi.fn(),
	},
	window: { showErrorMessage: vi.fn() },
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")

/**
 * `exportModeWithRules` が `customModePrompts` の上書きをどう扱うかの権威あるテスト。
 *
 * webview 側 (#273) には同じ規則を**写した**契約テストがあるが、あちらは写しを検証している
 * だけなので本物はここに置く。
 *
 * 押さえている性質:
 *   1. `undefined` と `{}` が同じ結果になる（空の上書きは no-op）
 *   2. 本物の上書きだけが出力を変え、他のフィールドは組み込みのまま
 *   3. **組み込み既定と同じ値の上書きは、上書きが無い場合とバイト単位で同一**
 *   4. 空文字の上書きは無視される
 */
describe("CustomModesManager.exportModeWithRules — prompt overrides", () => {
	let manager: CustomModesManager
	let builtInArchitect: ModeConfig

	const mockStoragePath = `${path.sep}mock${path.sep}settings`
	const mockSettingsPath = path.join(mockStoragePath, "settings", GlobalFileNames.customModes)
	const mockWorkspacePath = path.resolve("/mock/workspace")

	/** エクスポート結果の YAML を取り出す。失敗したら落とす。 */
	const exportYaml = async (slug: string, customPrompts?: PromptComponent): Promise<string> => {
		const result = await manager.exportModeWithRules(slug, customPrompts)

		if (!result.success || !result.yaml) {
			throw new Error(`export failed: ${result.error}`)
		}

		return result.yaml
	}

	const exportedMode = async (slug: string, customPrompts?: PromptComponent): Promise<Record<string, unknown>> =>
		yaml.parse(await exportYaml(slug, customPrompts)).customModes[0]

	beforeEach(async () => {
		const mockContext = {
			globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []), setKeysForSync: vi.fn() },
			globalStorageUri: { fsPath: mockStoragePath },
		} as unknown as vscode.ExtensionContext

		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: mockWorkspacePath } }]
		;(vscode.workspace.onDidSaveTextDocument as Mock).mockReturnValue({ dispose: vi.fn() })
		;(getWorkspacePath as Mock).mockReturnValue(mockWorkspacePath)
		// 設定ファイルだけ存在させる（.agentmodes は無し = 組み込み mode がそのまま土台になる）
		;(fileExistsAtPath as Mock).mockImplementation(async (p: string) => p === mockSettingsPath)
		;(fs.mkdir as Mock).mockResolvedValue(undefined)
		;(fs.writeFile as Mock).mockResolvedValue(undefined)
		// rules ディレクトリは無し（rulesFiles を出力から外して上書きだけを見る）
		;(fs.stat as Mock).mockRejectedValue(new Error("no rules dir"))
		;(fs.readdir as Mock).mockResolvedValue([])
		;(fs.rm as Mock).mockResolvedValue(undefined)
		;(fs.readFile as Mock).mockImplementation(async (p: string) => {
			if (p === mockSettingsPath) {
				return yaml.stringify({ customModes: [] })
			}

			throw new Error("File not found")
		})

		manager = new CustomModesManager(mockContext, vi.fn())

		const { modes } = await import("../../../shared/modes")
		// architect は 4 フィールドすべてに既定値を持つ組み込み mode。
		builtInArchitect = modes.find((m) => m.slug === "architect")!
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe("上書きが無い場合", () => {
		it("undefined と {} は同じ YAML を返す", async () => {
			expect(await exportYaml("architect", undefined)).toBe(await exportYaml("architect", {}))
		})

		it("組み込みの 4 フィールドがそのまま出る（エクスポートは差分ではなく完全なスナップショット）", async () => {
			const exported = await exportedMode("architect", {})

			expect(exported.roleDefinition).toBe(builtInArchitect.roleDefinition)
			expect(exported.description).toBe(builtInArchitect.description)
			expect(exported.whenToUse).toBe(builtInArchitect.whenToUse)
			expect(exported.customInstructions).toBe(builtInArchitect.customInstructions)
		})

		it("上書き由来のフィールドは 1 つも無い（＝組み込みと完全一致）", async () => {
			const exported = await exportedMode("architect", {})

			for (const field of ["roleDefinition", "description", "whenToUse", "customInstructions"] as const) {
				expect(exported[field]).toBe(builtInArchitect[field])
			}
		})
	})

	describe("本物の上書きがある場合", () => {
		it("上書きしたフィールドだけが変わる", async () => {
			const exported = await exportedMode("architect", { roleDefinition: "MY ROLE" })

			expect(exported.roleDefinition).toBe("MY ROLE")
			// 残りは組み込みのまま
			expect(exported.description).toBe(builtInArchitect.description)
			expect(exported.whenToUse).toBe(builtInArchitect.whenToUse)
			expect(exported.customInstructions).toBe(builtInArchitect.customInstructions)
		})

		it.each(["roleDefinition", "description", "whenToUse", "customInstructions"] as const)(
			"%s の上書きが出力に反映される",
			async (field) => {
				const exported = await exportedMode("architect", { [field]: `OVERRIDDEN ${field}` })

				expect(exported[field]).toBe(`OVERRIDDEN ${field}`)
			},
		)

		it("複数フィールドの上書きをすべて反映する", async () => {
			const exported = await exportedMode("architect", {
				roleDefinition: "MY ROLE",
				customInstructions: "MY INSTRUCTIONS",
			})

			expect(exported.roleDefinition).toBe("MY ROLE")
			expect(exported.customInstructions).toBe("MY INSTRUCTIONS")
			expect(exported.whenToUse).toBe(builtInArchitect.whenToUse)
		})

		it("上書きがあると、上書き無しの YAML とは異なる", async () => {
			expect(await exportYaml("architect", { roleDefinition: "MY ROLE" })).not.toBe(
				await exportYaml("architect", undefined),
			)
		})
	})

	describe("組み込み既定と同じ値の上書き（#273 の漏れが到達する形）", () => {
		it("上書きが無い場合とバイト単位で同一になる", async () => {
			// エクスポートは同じ値で上書きするだけなので no-op。
			// これが「エクスポート経路に scrub が不要」の根拠。
			const withRedundant = await exportYaml("architect", {
				customInstructions: builtInArchitect.customInstructions,
			})

			expect(withRedundant).toBe(await exportYaml("architect", undefined))
		})

		it("漏れた上書き（本物 + 既定と同じ値）は、きれいな上書きと同一になる", async () => {
			// #273 で修正した漏れは globalState には残るが、エクスポート結果には現れない。
			const leaked = await exportYaml("architect", {
				roleDefinition: "MY ROLE",
				customInstructions: builtInArchitect.customInstructions,
			})
			const clean = await exportYaml("architect", { roleDefinition: "MY ROLE" })

			expect(leaked).toBe(clean)
		})

		it.each(["roleDefinition", "description", "whenToUse", "customInstructions"] as const)(
			"%s を既定と同じ値で上書きしても出力は変わらない",
			async (field) => {
				const redundant = await exportYaml("architect", { [field]: builtInArchitect[field] })

				expect(redundant).toBe(await exportYaml("architect", undefined))
			},
		)
	})

	describe("falsy な上書きは無視される", () => {
		it("空文字は上書きとして扱わない", async () => {
			const exported = await exportedMode("architect", { roleDefinition: "", customInstructions: "" })

			expect(exported.roleDefinition).toBe(builtInArchitect.roleDefinition)
			expect(exported.customInstructions).toBe(builtInArchitect.customInstructions)
		})

		it("空文字だけの上書きは上書き無しと同一の YAML になる", async () => {
			expect(await exportYaml("architect", { roleDefinition: "", whenToUse: "" })).toBe(
				await exportYaml("architect", undefined),
			)
		})
	})
})
