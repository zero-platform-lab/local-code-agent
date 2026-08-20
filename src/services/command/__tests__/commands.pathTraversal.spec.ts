import path from "path"
import fs from "fs/promises"

import { getCommand } from "../commands"

// getCommand の containment ガードだけを検証する。fs と agent ディレクトリはモック。
// 注意: モックのパスはテストファイル基準。__tests__ から見た agent-config は `../../agent-config`。
vi.mock("fs/promises")
vi.mock("../../agent-config", () => ({
	getGlobalAgentDirectory: vi.fn(() => "/mock/global/.agent"),
	getProjectAgentDirectoryForCwd: vi.fn(() => "/mock/project/.agent"),
}))
vi.mock("../built-in-commands", () => ({
	getBuiltInCommands: vi.fn(() => Promise.resolve([])),
	getBuiltInCommand: vi.fn(() => Promise.resolve(undefined)),
	getBuiltInCommandNames: vi.fn(() => Promise.resolve([])),
}))

const mockFs = vi.mocked(fs)

const PROJECT_COMMANDS = "/mock/project/.agent/commands"
const GLOBAL_COMMANDS = "/mock/global/.agent/commands"

/** readFile に渡った全パスが commands ディレクトリ配下（正規化後）か。 */
function expectAllReadsInsideCommandDirs() {
	for (const call of mockFs.readFile.mock.calls) {
		const p = path.resolve(String(call[0]))
		const inProject = p === PROJECT_COMMANDS || p.startsWith(PROJECT_COMMANDS + path.sep)
		const inGlobal = p === GLOBAL_COMMANDS || p.startsWith(GLOBAL_COMMANDS + path.sep)
		expect(inProject || inGlobal, `commands ディレクトリの外を読んだ: ${p}`).toBe(true)
	}
}

describe("getCommand - パストラバーサル封じ込め", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
		mockFs.readFile = vi.fn().mockRejectedValue(new Error("ENOENT"))
		mockFs.lstat = vi.fn().mockRejectedValue(new Error("ENOENT"))
	})

	// name はモデル由来。`..` を含むと path.join の正規化で commands ディレクトリの外へ抜ける。
	it.each([
		["親へ 1 段", "../secret"],
		["ルートまで", "../../../../etc/passwd"],
		["途中まで潜って抜ける", "sub/../../escape"],
	])("%s（%s）は commands ディレクトリの外を読まない", async (_label, name) => {
		const result = await getCommand("/workspace", name)

		expect(result).toBeUndefined()
		// 抜けた先の .md を読みに行っていない（readFile が 1 度も飛んでいないか、飛んでも配下）。
		expectAllReadsInsideCommandDirs()
	})

	it("`../../../../etc/passwd` では /etc/passwd に readFile が飛ばない", async () => {
		await getCommand("/workspace", "../../../../etc/passwd")
		for (const call of mockFs.readFile.mock.calls) {
			expect(String(call[0])).not.toContain("etc/passwd")
		}
	})

	it("正当なサブディレクトリ名は許す（配下に留まる限り読みに行く）", async () => {
		await getCommand("/workspace", "group/deploy")
		expect(mockFs.readFile).toHaveBeenCalledWith(`${PROJECT_COMMANDS}/group/deploy.md`, "utf-8")
		expectAllReadsInsideCommandDirs()
	})

	it("通常の 1 セグメント名は従来どおり読みに行く", async () => {
		await getCommand("/workspace", "deploy")
		expect(mockFs.readFile).toHaveBeenCalledWith(`${PROJECT_COMMANDS}/deploy.md`, "utf-8")
	})
})
