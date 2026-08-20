import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
		coverage: {
			// 網羅率の床。**下がったら CI を落とす**ためのもので、目標値ではない。
			// 目標は .agent/rules のとおり「触ったファイルは C1 100%」。
			// ここを引き上げるのは歓迎、下げるのは要相談。
			thresholds: { statements: 98.4, branches: 97.2, functions: 88.4, lines: 98.4 },
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
