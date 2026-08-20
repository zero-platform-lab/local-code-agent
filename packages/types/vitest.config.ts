import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		watch: false,
		coverage: {
			// 網羅率の床。**下がったら CI を落とす**ためのもので、目標値ではない。
			// 目標は .agent/rules のとおり「触ったファイルは C1 100%」。
			// ここを引き上げるのは歓迎、下げるのは要相談。
			thresholds: { statements: 78, branches: 91, functions: 47, lines: 78 },
		},
	},
})
