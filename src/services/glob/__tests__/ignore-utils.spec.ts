import { isPathInIgnoredDirectory } from "../ignore-utils"

// isPathInIgnoredDirectory は純粋関数（fs/子プロセス不使用）。
// 外部由来のパスで無限に呼ばれても落ちないこと、および各判定分岐を検証する。
describe("isPathInIgnoredDirectory", () => {
	it("隠しディレクトリ（.* パターン）を含むパスは無視対象", () => {
		// part が "." 始まりかつ "." 単体でない → 隠しディレクトリ判定（21-23 行）
		expect(isPathInIgnoredDirectory("/project/.hidden/file.ts")).toBe(true)
	})

	it("パスセグメント単体がドット1つの場合は隠し判定に引っかからない", () => {
		// "." 単体は除外対象にしない（part !== "." のガード）。
		// カレントディレクトリ相対表記だけなら false。
		expect(isPathInIgnoredDirectory("./src/index.ts")).toBe(false)
	})

	it("DIRS_TO_IGNORE の完全一致セグメント（非隠し）を無視対象にする", () => {
		// "node_modules" は "." 始まりでないので exact-match 分岐（26-28 行）で拾う
		expect(isPathInIgnoredDirectory("/project/node_modules/pkg/index.js")).toBe(true)
		expect(isPathInIgnoredDirectory("dist/bundle.js")).toBe(true)
		expect(isPathInIgnoredDirectory("out/main.js")).toBe(true)
	})

	it("スラッシュ入りパターン（target/dependency）は部分文字列走査分岐で拾う", () => {
		// "target" 単体も "dependency" 単体も DIRS_TO_IGNORE に無いので前半ループは素通りし、
		// 後半の normalizedPath.includes(`/target/dependency/`) で true（32-42 行）。
		expect(isPathInIgnoredDirectory("/a/target/dependency/lib.jar")).toBe(true)
		expect(isPathInIgnoredDirectory("/a/build/dependencies/x")).toBe(true)
	})

	it("Windows 区切り文字 (\\) は正規化してから判定する", () => {
		expect(isPathInIgnoredDirectory("C:\\proj\\node_modules\\x.js")).toBe(true)
		expect(isPathInIgnoredDirectory("C:\\proj\\src\\x.ts")).toBe(false)
	})

	it("先頭/末尾スラッシュの空セグメントは continue でスキップする", () => {
		// 先頭・末尾・連続スラッシュで空 part が出るが、それらは無視対象を誤検出しない。
		expect(isPathInIgnoredDirectory("//project//src//index.ts")).toBe(false)
	})

	it("無視対象ディレクトリを含まないパスは false（後半ループ完走 → 44 行）", () => {
		expect(isPathInIgnoredDirectory("/project/src/services/index.ts")).toBe(false)
		expect(isPathInIgnoredDirectory("")).toBe(false)
	})

	it("巨大な深いパスでも例外なく判定できる", () => {
		const deep = "/root/" + Array.from({ length: 5000 }, (_, i) => `seg${i}`).join("/") + "/file.ts"
		expect(() => isPathInIgnoredDirectory(deep)).not.toThrow()
		expect(isPathInIgnoredDirectory(deep)).toBe(false)
		// 途中に無視対象があれば true になる
		expect(isPathInIgnoredDirectory(deep.replace("seg2500", "node_modules"))).toBe(true)
	})
})
