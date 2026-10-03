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
			// vitest 4 へ上げたとき、statements / branches / lines を下げ、functions を上げた
			// （98.4 / 97.2 / 88.4 / 98.4 → 97.5 / 95.5 / 94.7 / 97.8）。vitest 4 は分岐を AST から数えるので、
			// vitest 3 が数えなかった if の暗黙の else や `??` の右辺が母数に入った。試験は同じ 8754 件で、
			// 網羅率そのものは下がっていない。値は vitest 4 で測った値を小数 1 桁へ切り捨てたもの。
			// 元の水準へ戻すのは、試験を足す後続の作業で行う。
			thresholds: { statements: 97.5, branches: 95.5, functions: 94.7, lines: 97.8 },
			// vitest 4 で coverage.all が無くなり、include を書かないと「試験が読み込んだファイル」
			// だけが母数になる。どの試験も読まないファイルを床から外さないよう、母数を明示する。
			// 試験の補助（__tests__ 配下の fixture や helper）と手書きモックは製品コードではないので外す。
			include: ["**/*.ts"],
			exclude: ["**/__tests__/**", "**/__mocks__/**", "**/*.d.ts", "node_modules/**", "dist/**"],
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
