// バージョン入りのファイル名で SBOM を生成する薄いラッパー。
//
// 生成そのものは OWASP の cdxgen（devDependency）が行う。自前で組み立てないのは、
// NTIA の「SBOM 最小要素」が依存関係グラフを求めており、仕様追従とスキーマ検証を
// ツール側に任せた方が確実なため。cdxgen は --validate が既定で有効なので、
// 生成時に JSON Schema 検証も走る。
//
// --required-only: 本番依存だけを対象にする（開発依存は配布物に入らない）。

const { execFileSync } = require("child_process")

const { version } = require("./../src/package.json")
const out = `bin/openai-agent-${version}.sbom.cdx.json`

execFileSync("cdxgen", ["-t", "pnpm", "--spec-version", "1.5", "--required-only", "-o", out, "."], { stdio: "inherit" })

console.log(`SBOM: ${out}`)
