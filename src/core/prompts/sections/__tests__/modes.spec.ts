// npx vitest run core/prompts/sections/__tests__/modes.spec.ts

import type * as vscode from "vscode"
import type { ModeConfig } from "@openai-agent/types"

// shared/modes と utils/globalContext をモック。
// パスは modes.ts が解決するのと同一の絶対モジュールに向ける
// （1 階層ずれるとモックが効かず「見せかけテスト」になるため、
//  下のテストで戻り値が実際に使われることを検証する）。
const { mockGetAllModesWithPrompts, mockEnsureSettingsDirectoryExists } = vi.hoisted(() => ({
	mockGetAllModesWithPrompts: vi.fn(),
	mockEnsureSettingsDirectoryExists: vi.fn(),
}))

vi.mock("../../../../shared/modes", () => ({
	getAllModesWithPrompts: mockGetAllModesWithPrompts,
}))

vi.mock("../../../../utils/globalContext", () => ({
	ensureSettingsDirectoryExists: mockEnsureSettingsDirectoryExists,
}))

import { getModesSection } from "../modes"

const fakeContext = { extensionPath: "/ext" } as unknown as vscode.ExtensionContext

const makeMode = (partial: Partial<ModeConfig> & { slug: string; name: string }): ModeConfig =>
	({
		roleDefinition: "",
		groups: [],
		...partial,
	}) as ModeConfig

describe("getModesSection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockEnsureSettingsDirectoryExists.mockResolvedValue("/settings")
	})

	it("設定ディレクトリの作成を保証してからモード一覧を組み立てる", async () => {
		mockGetAllModesWithPrompts.mockResolvedValue([
			makeMode({ slug: "code", name: "Code", whenToUse: "Use for coding tasks" }),
		])

		const result = await getModesSection(fakeContext)

		// ensureSettingsDirectoryExists が context を渡して呼ばれる（パス作成の副作用）
		expect(mockEnsureSettingsDirectoryExists).toHaveBeenCalledWith(fakeContext)
		expect(mockGetAllModesWithPrompts).toHaveBeenCalledWith(fakeContext)
		// モック戻り値が本当に使われていることの確認（見せかけテスト検知）
		expect(result).toContain("MODES")
		expect(result).toContain('* "Code" mode (code) - Use for coding tasks')
	})

	it("whenToUse があればそれを説明に使い、改行はインデントされる", async () => {
		mockGetAllModesWithPrompts.mockResolvedValue([
			makeMode({ slug: "architect", name: "Architect", whenToUse: "First line\nSecond line" }),
		])

		const result = await getModesSection(fakeContext)

		// 2 行目以降はインデント（\n + 4 space）される
		expect(result).toContain('* "Architect" mode (architect) - First line\n    Second line')
	})

	it("whenToUse が空白のみなら roleDefinition の最初の文にフォールバックする", async () => {
		mockGetAllModesWithPrompts.mockResolvedValue([
			makeMode({
				slug: "ask",
				name: "Ask",
				whenToUse: "   ",
				roleDefinition: "You answer questions. You do not edit files.",
			}),
		])

		const result = await getModesSection(fakeContext)

		// "." で分割した最初の文だけが使われる
		expect(result).toContain('* "Ask" mode (ask) - You answer questions')
		expect(result).not.toContain("You do not edit files")
	})

	it("whenToUse が未定義でも roleDefinition にフォールバックする", async () => {
		mockGetAllModesWithPrompts.mockResolvedValue([
			makeMode({ slug: "debug", name: "Debug", roleDefinition: "You debug problems methodically" }),
		])

		const result = await getModesSection(fakeContext)

		expect(result).toContain('* "Debug" mode (debug) - You debug problems methodically')
	})

	it("複数モードを改行で連結する", async () => {
		mockGetAllModesWithPrompts.mockResolvedValue([
			makeMode({ slug: "code", name: "Code", whenToUse: "coding" }),
			makeMode({ slug: "ask", name: "Ask", whenToUse: "asking" }),
		])

		const result = await getModesSection(fakeContext)

		expect(result).toContain('* "Code" mode (code) - coding')
		expect(result).toContain('* "Ask" mode (ask) - asking')
	})
})
