const { execSync } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

// CycloneDX 1.5 の SBOM を、.vsix に**実際に入ったモジュール**から生成する。
//
// なぜ宣言ベース（package.json / lockfile）ではないのか:
// この拡張は `vsce package --no-dependencies` で梱包し、`.vscodeignore` が
// node_modules を全除外する。配布物に入るのは esbuild が束ねた dist/ と
// vite が束ねた webview-ui/build/assets/ だけである。したがって宣言上の依存一覧は
// 配布物の中身と一致しない（取り込まれない依存が載り、実態を過大に見せる）。
//
// 入力:
//   src/esbuild-metafile.json  … esbuild の metafile（extension と worker）
//   webview-ui/vite-modules.json … rollup が取り込んだモジュール ID
// どちらもビルド時に生成される。SBOM を作る前にビルドが要る。

const ROOT = path.join(__dirname, "..")

/** pnpm のレイアウト `node_modules/.pnpm/<name>@<version>[_peer]/node_modules/<name>/…` を解く。 */
const PNPM_PATH = /node_modules\/\.pnpm\/(.+?)@([0-9][^/]*)\/node_modules\//

function packagesFromPaths(paths) {
	const found = new Map()

	for (const p of paths) {
		const m = PNPM_PATH.exec(p)
		if (!m) continue

		// スコープ付きは `@scope+name` の形で入るので戻す。
		const name = m[1].replace("+", "/")
		// peer 依存の識別子（`1.2.3_react@18.0.0`）が付くことがあるので落とす。
		const version = m[2].split("_")[0]
		found.set(`${name}@${version}`, { name, version })
	}

	return found
}

function readJson(file) {
	if (!fs.existsSync(file)) {
		throw new Error(`${path.relative(ROOT, file)} が無い。先に pnpm bundle を実行すること。`)
	}
	return JSON.parse(fs.readFileSync(file, "utf-8"))
}

/** (name, version) → SPDX ライセンス文字列 */
function licenseIndex() {
	const index = new Map()
	const raw = execSync("pnpm licenses list --json", { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })

	for (const [license, packages] of Object.entries(JSON.parse(raw))) {
		for (const pkg of packages) {
			for (const version of pkg.versions) {
				index.set(`${pkg.name}@${version}`, license)
			}
		}
	}

	return index
}

const purlOf = (name, version) => `pkg:npm/${name.replace("@", "%40")}@${version}`

/** SPDX 式（複合ライセンス）は expression、単一は name として出す。 */
function licensesOf(raw) {
	if (!raw || raw === "Unknown") return undefined
	if (/[()]| OR | AND | WITH /.test(raw)) return [{ expression: raw }]
	return [{ license: { name: raw } }]
}

function main() {
	const extensionPkg = readJson(path.join(ROOT, "src", "package.json"))

	const metafile = readJson(path.join(ROOT, "src", "esbuild-metafile.json"))
	const viteModules = readJson(path.join(ROOT, "webview-ui", "vite-modules.json"))

	const bundled = new Map([
		...packagesFromPaths(Object.keys(metafile.extension.inputs)),
		...packagesFromPaths(Object.keys(metafile.worker.inputs)),
		...packagesFromPaths(viteModules),
	])

	const licenses = licenseIndex()

	const components = [...bundled.values()]
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
		.map(({ name, version }) => {
			const component = {
				type: "library",
				"bom-ref": purlOf(name, version),
				name,
				version,
				purl: purlOf(name, version),
			}

			const license = licensesOf(licenses.get(`${name}@${version}`))
			if (license) component.licenses = license

			return component
		})

	const rootRef = purlOf(extensionPkg.name, extensionPkg.version)

	const bom = {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		serialNumber: `urn:uuid:${crypto.randomUUID()}`,
		version: 1,
		metadata: {
			timestamp: new Date().toISOString(),
			tools: [{ name: "generate-sbom.js", version: "2" }],
			component: {
				type: "application",
				"bom-ref": rootRef,
				name: extensionPkg.name,
				version: extensionPkg.version,
				description: "OpenAI Compatible Agent (VS Code extension)",
				licenses: [{ license: { name: "Apache-2.0" } }],
				purl: rootRef,
			},
		},
		components,
		// バンドル後は個々のパッケージ間の依存辺が消える（1 ファイルに畳まれる）ため、
		// 「配布物が全部品に依存する」という平坦な関係として表す。事実に反する辺を
		// 作らないための選択であり、NTIA の依存関係要件はこの粒度で満たす。
		dependencies: [
			{ ref: rootRef, dependsOn: components.map((c) => c["bom-ref"]) },
			...components.map((c) => ({ ref: c["bom-ref"], dependsOn: [] })),
		],
	}

	fs.mkdirSync(path.join(ROOT, "bin"), { recursive: true })
	const out = path.join(ROOT, "bin", `openai-agent-${extensionPkg.version}.sbom.cdx.json`)
	fs.writeFileSync(out, JSON.stringify(bom, null, "\t") + "\n")

	console.log(`SBOM: ${path.relative(ROOT, out)} — ${components.length} components`)
}

main()
