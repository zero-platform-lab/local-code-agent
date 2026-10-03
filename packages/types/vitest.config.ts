import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		watch: false,
		coverage: {
			// 網羅率の床。**下がったら CI を落とす**ためのもので、目標値ではない。
			// 目標は .agent/rules のとおり「触ったファイルは C1 100%」。
			// ここを引き上げるのは歓迎、下げるのは要相談。
			// vitest 4 で数え方が変わった（AST に基づく対応付け）ため、vitest 3 の値（81/96/85/81）から
			// 測り直した値へ引き上げた。vitest 3 は試験が読まない scripts/publish-npm.cjs を
			// 文 289・分岐 1・関数 1 として母数に入れていたが、vitest 4 は中身を数える（文 179・分岐 22・
			// 関数 14）。配布物に入らない公開用の script なので、母数から外し、src の床を上げる。
			thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
			// vitest 4 で coverage.all が無くなり、include を書かないと「試験が読み込んだファイル」
			// だけが母数になる。どの試験も読まないファイルを床から外さないよう、母数を明示する。
			include: ["src/**/*.ts"],
		},
	},
})
