import path from "path"
import { AgentProtectedController } from "../AgentProtectedController"

describe("AgentProtectedController", () => {
	const TEST_CWD = "/test/workspace"
	let controller: AgentProtectedController

	beforeEach(() => {
		controller = new AgentProtectedController(TEST_CWD)
	})

	describe("isWriteProtected", () => {
		it("should protect .agentignore file", () => {
			expect(controller.isWriteProtected(".agentignore")).toBe(true)
		})

		it("should protect files in .agent directory", () => {
			expect(controller.isWriteProtected(".agent/config.json")).toBe(true)
			expect(controller.isWriteProtected(".agent/settings/user.json")).toBe(true)
			expect(controller.isWriteProtected(".agent/modes/custom.json")).toBe(true)
		})

		it("should protect .agentprotected file", () => {
			expect(controller.isWriteProtected(".agentprotected")).toBe(true)
		})

		it("should protect .agentrules* files", () => {
			expect(controller.isWriteProtected(".agentrules")).toBe(true)
			expect(controller.isWriteProtected(".agentrules.md")).toBe(true)
		})

		it("should protect .clinerules* files", () => {
			expect(controller.isWriteProtected(".clinerules")).toBe(true)
			expect(controller.isWriteProtected(".clinerules.md")).toBe(true)
		})

		it("should protect files in .vscode directory", () => {
			expect(controller.isWriteProtected(".vscode/settings.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/launch.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/tasks.json")).toBe(true)
		})

		it("should protect .code-workspace files", () => {
			expect(controller.isWriteProtected("myproject.code-workspace")).toBe(true)
			expect(controller.isWriteProtected("pentest.code-workspace")).toBe(true)
			expect(controller.isWriteProtected(".code-workspace")).toBe(true)
			expect(controller.isWriteProtected("folder/workspace.code-workspace")).toBe(true)
		})

		it("should protect AGENTS.md file", () => {
			expect(controller.isWriteProtected("AGENTS.md")).toBe(true)
		})

		it("should protect AGENT.md file", () => {
			expect(controller.isWriteProtected("AGENT.md")).toBe(true)
		})

		it("should not protect other files starting with .agent", () => {
			expect(controller.isWriteProtected(".agentsettings")).toBe(false)
			expect(controller.isWriteProtected(".agentconfig")).toBe(false)
		})

		it("should not protect regular files", () => {
			expect(controller.isWriteProtected("src/index.ts")).toBe(false)
			expect(controller.isWriteProtected("package.json")).toBe(false)
			expect(controller.isWriteProtected("README.md")).toBe(false)
		})

		it("should not protect files that contain 'agent' but don't start with .agent", () => {
			expect(controller.isWriteProtected("src/agent-utils.ts")).toBe(false)
			expect(controller.isWriteProtected("config/agent.config.js")).toBe(false)
		})

		it("should handle nested paths correctly", () => {
			expect(controller.isWriteProtected(".agent/config.json")).toBe(true) // .agent/** matches at root
			expect(controller.isWriteProtected("nested/.agentignore")).toBe(true) // .agentignore matches anywhere by default
			expect(controller.isWriteProtected("nested/.agentrules.md")).toBe(true) // .agentrules* matches anywhere by default
		})

		it("should handle absolute paths by converting to relative", () => {
			const absolutePath = path.join(TEST_CWD, ".agentignore")
			expect(controller.isWriteProtected(absolutePath)).toBe(true)
		})

		it("should handle paths with different separators", () => {
			expect(controller.isWriteProtected(".agent\\config.json")).toBe(true)
			expect(controller.isWriteProtected(".agent/config.json")).toBe(true)
		})

		it("should not throw for absolute paths outside cwd", () => {
			expect(controller.isWriteProtected("/tmp/comment-2-pr63.json")).toBe(false)
			expect(controller.isWriteProtected("/etc/passwd")).toBe(false)
		})

		it("should fail safe (return false) and log when the matcher throws", () => {
			// 内部の ignore マッチャが想定外の例外を投げても、パス処理は落ちずに
			// 「保護されていない」として扱う（誤検知よりも安全側に倒す）ことを固定する。
			// ".agentignore" は ".." で始まらないので早期 return を通り抜け、ignores() まで到達する。
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const ignoresSpy = vi.spyOn((controller as any).ignoreInstance, "ignores").mockImplementation(() => {
				throw new Error("boom")
			})

			expect(controller.isWriteProtected(".agentignore")).toBe(false)
			expect(ignoresSpy).toHaveBeenCalled()
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining("Error checking protection for .agentignore"),
				expect.any(Error),
			)

			ignoresSpy.mockRestore()
			consoleSpy.mockRestore()
		})
	})

	describe("getProtectedFiles", () => {
		it("should return set of protected files from a list", () => {
			const files = ["src/index.ts", ".agentignore", "package.json", ".agent/config.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set([".agentignore", ".agent/config.json"]))
		})

		it("should return empty set when no files are protected", () => {
			const files = ["src/index.ts", "package.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set())
		})
	})

	describe("annotatePathsWithProtection", () => {
		it("should annotate paths with protection status", () => {
			const files = ["src/index.ts", ".agentignore", ".agent/config.json", "package.json"]

			const annotated = controller.annotatePathsWithProtection(files)

			expect(annotated).toEqual([
				{ path: "src/index.ts", isProtected: false },
				{ path: ".agentignore", isProtected: true },
				{ path: ".agent/config.json", isProtected: true },
				{ path: "package.json", isProtected: false },
			])
		})
	})

	describe("getProtectionMessage", () => {
		it("should return appropriate protection message", () => {
			const message = controller.getProtectionMessage()
			expect(message).toBe("This is an Agent configuration file and requires approval for modifications")
		})
	})

	describe("getInstructions", () => {
		it("should return formatted instructions about protected files", () => {
			const instructions = controller.getInstructions()

			expect(instructions).toContain("# Protected Files")
			expect(instructions).toContain("write-protected")
			expect(instructions).toContain(".agentignore")
			expect(instructions).toContain(".agent/**")
			expect(instructions).toContain("\u{1F6E1}") // Shield symbol
		})
	})

	describe("getProtectedPatterns", () => {
		it("should return the list of protected patterns", () => {
			const patterns = AgentProtectedController.getProtectedPatterns()

			expect(patterns).toEqual([
				".agentignore",
				".agentrules*",
				".clinerules*",
				".agent/**",
				".vscode/**",
				"*.code-workspace",
				".agentprotected",
				"AGENTS.md",
				"AGENT.md",
			])
		})
	})
})
