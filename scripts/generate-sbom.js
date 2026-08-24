const { execSync } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

// CycloneDX 1.5 JSON の SBOM を生成する。
//
// 対象は「拡張パッケージ（openai-agent）の本番依存の閉包」を pnpm が解決した
// バージョンで並べたもの。開発依存は含めない。
//
// 注意: これは package.json の宣言に基づく一覧であり、esbuild が実際にバンドルへ
// 取り込んだモジュールの集合そのものではない（宣言ベースの上位集合になる。
// たとえばビルド系 workspace パッケージが本番依存として宣言するツール類を含む）。
// 正確な同梱集合が必要になったら esbuild の metafile から生成する方式へ切り替える。
//
// 外部の SBOM 生成ツールを依存に足さないのは意図的である。audit 0 件の維持と
// knip の未使用検出を汚さないため、pnpm 自身の JSON 出力だけで組み立てる。

const run = (cmd) => execSync(cmd, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })

// SPDX の式（複合ライセンス）かどうか。式は expression、それ以外は name として出す。
// id として出すには SPDX の正準リストとの照合が要るため、常に妥当な name を使う。
const licenseEntry = (raw) => {
	if (!raw || raw === "Unknown") return undefined
	if (/[()]| OR | AND | WITH /.test(raw)) return [{ expression: raw }]
	return [{ license: { name: raw } }]
}

const purl = (name, version) => `pkg:npm/${name.replace("@", "%40")}@${version}`

function main() {
	const extension = JSON.parse(fs.readFileSync(path.join("src", "package.json"), "utf-8"))

	// (name, version) → ライセンス文字列
	const licenseByPkg = new Map()
	const licensesJson = JSON.parse(run("pnpm licenses list --json"))
	for (const [license, packages] of Object.entries(licensesJson)) {
		for (const pkg of packages) {
			for (const version of pkg.versions) {
				licenseByPkg.set(`${pkg.name}@${version}`, license)
			}
		}
	}

	// 拡張パッケージの本番依存の閉包（解決済みバージョン）
	const tree = JSON.parse(run("pnpm --filter openai-agent list --prod --json --depth Infinity"))
	const seen = new Map()
	const walk = (deps) => {
		for (const [name, info] of Object.entries(deps ?? {})) {
			const version = info.version
			if (version && !version.startsWith("link:")) {
				seen.set(`${name}@${version}`, { name, version })
			}
			walk(info.dependencies)
		}
	}
	walk(tree[0]?.dependencies)

	const components = [...seen.values()]
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
		.map(({ name, version }) => {
			const component = {
				type: "library",
				"bom-ref": purl(name, version),
				name,
				version,
				purl: purl(name, version),
			}
			const licenses = licenseEntry(licenseByPkg.get(`${name}@${version}`))
			if (licenses) component.licenses = licenses
			return component
		})

	const bom = {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		serialNumber: `urn:uuid:${crypto.randomUUID()}`,
		version: 1,
		metadata: {
			timestamp: new Date().toISOString(),
			tools: [{ name: "generate-sbom.js", version: "1" }],
			component: {
				type: "application",
				"bom-ref": `pkg:npm/${extension.name}@${extension.version}`,
				name: extension.name,
				version: extension.version,
				description: "OpenAI Compatible Agent (VS Code extension)",
				licenses: [{ license: { name: "Apache-2.0" } }],
			},
		},
		components,
	}

	fs.mkdirSync("bin", { recursive: true })
	const outPath = path.join("bin", `${extension.name}-${extension.version}.sbom.cdx.json`)
	fs.writeFileSync(outPath, JSON.stringify(bom, null, "\t") + "\n")
	console.log(`SBOM: ${outPath} (${components.length} components)`)
}

main()
