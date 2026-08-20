import { coverageConfigDefaults, defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		environment: "jsdom",
		include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
		onConsoleLog,
		coverage: {
			// 網羅率の床。**下がったら CI を落とす**ためのもので、目標値ではない。
			// 目標は .agent/rules のとおり「触ったファイルは C1 100%」。
			// ここを引き上げるのは歓迎、下げるのは要相談。
			thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
			// 手書きモックはテスト側の道具なので、製品コードの網羅率に混ぜない。
			exclude: [...(coverageConfigDefaults.exclude ?? []), "src/**/__mocks__/**"],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@src": path.resolve(__dirname, "./src"),
			"@agent": path.resolve(__dirname, "../src/shared"),
			// Mock the vscode module for tests since it's not available outside
			// VS Code extension context.
			vscode: path.resolve(__dirname, "./src/__mocks__/vscode.ts"),
		},
	},
})
