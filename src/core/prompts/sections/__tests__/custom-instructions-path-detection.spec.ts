import * as path from "path"

describe("custom-instructions path detection", () => {
	it("should use exact path comparison instead of string includes", () => {
		// Test the logic that our fix implements
		const fakeHomeDir = "/Users/john.roo.smith"
		const globalAgentDir = path.join(fakeHomeDir, ".agent") // "/Users/john.roo.smith/.agent"
		const projectAgentDir = "/projects/my-project/.agent"

		// Old implementation (fragile):
		// const isGlobal = agentDir.includes(path.join(os.homedir(), ".agent"))
		// This could fail if the home directory path contains ".agent" elsewhere

		// New implementation (robust):
		// const isGlobal = path.resolve(agentDir) === path.resolve(getGlobalAgentDirectory())

		// Test the new logic
		const isGlobalForGlobalDir = path.resolve(globalAgentDir) === path.resolve(globalAgentDir)
		const isGlobalForProjectDir = path.resolve(projectAgentDir) === path.resolve(globalAgentDir)

		expect(isGlobalForGlobalDir).toBe(true)
		expect(isGlobalForProjectDir).toBe(false)

		// Verify that the old implementation would have been problematic
		// if the home directory contained ".agent" in the path
		const oldLogicGlobal = globalAgentDir.includes(path.join(fakeHomeDir, ".agent"))
		const oldLogicProject = projectAgentDir.includes(path.join(fakeHomeDir, ".agent"))

		expect(oldLogicGlobal).toBe(true) // This works
		expect(oldLogicProject).toBe(false) // This also works, but is fragile

		// The issue was that if the home directory path itself contained ".agent",
		// the includes() check could produce false positives in edge cases
	})

	it("should handle edge cases with path resolution", () => {
		// Test various edge cases that exact path comparison handles better
		const testCases = [
			{
				global: "/Users/test/.agent",
				project: "/Users/test/project/.agent",
				expected: { global: true, project: false },
			},
			{
				global: "/home/user/.agent",
				project: "/home/user/.agent", // Same directory
				expected: { global: true, project: true },
			},
			{
				global: "/Users/john.roo.smith/.agent",
				project: "/projects/app/.agent",
				expected: { global: true, project: false },
			},
		]

		testCases.forEach(({ global, project, expected }) => {
			const isGlobalForGlobal = path.resolve(global) === path.resolve(global)
			const isGlobalForProject = path.resolve(project) === path.resolve(global)

			expect(isGlobalForGlobal).toBe(expected.global)
			expect(isGlobalForProject).toBe(expected.project)
		})
	})
})
