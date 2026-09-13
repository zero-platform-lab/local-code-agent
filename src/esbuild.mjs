import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, copyOnnxRuntime, setupLocaleWatcher } from "@openai-agent/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function removeDirWithRetries(dirPath, retries = 5, retryDelayMs = 200) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fs.promises.rm(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isRetryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM"
			const isLastAttempt = attempt === retries

			if (!isRetryable || isLastAttempt) {
				throw error
			}

			await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * (attempt + 1)))
		}
	}
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	// 配る先。`--target=linux-x64` の形。環境変数だと Windows で書き方が変わるので引数で受ける。
	const target = process.argv.find((one) => one.startsWith("--target="))?.slice("--target=".length)
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
		// SBOM 生成用。バンドルへ実際に取り込まれた入力ファイルの一覧が要る。
		// .vsix には node_modules が入らない（.vscodeignore が全除外）ため、宣言上の
		// 依存ではなく metafile の inputs が同梱物の正だけを表す。
		metafile: true,
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		await removeDirWithRetries(distDir)
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../LICENSE", "LICENSE"],
							["../.env", ".env", { optional: true }],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyOnnxRuntime",
			setup(build) {
				build.onEnd(() => copyOnnxRuntime(srcDir, distDir, target))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		// onnxruntime-node は束ねない。native の実行ファイルを
		// `require(`../bin/napi-v6/${process.platform}/...`)` で読むため、束ねると相対の
		// 位置がずれる。`dist/node_modules/` へ写して、そこから解決させる。
		external: ["vscode", "esbuild", "global-agent", "onnxruntime-node"],
		alias: {
			// 画像を扱うためのもので、本製品は使わない。同梱すると 16.5 MB 増える。
			sharp: "./build-stubs/sharp.js",
		},
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		const [extensionResult, workerResult] = await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])

		// metafile を dist の隣へ出す。scripts/generate-sbom.js がこれを読む。
		// dist/ 自体は .vscodeignore の許可リストに入っているので、metafile は
		// dist の外（build ディレクトリ直下）へ置いて .vsix に混入させない。
		fs.writeFileSync(
			path.join(buildDir, "esbuild-metafile.json"),
			JSON.stringify({ extension: extensionResult.metafile, worker: workerResult.metafile }),
		)

		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
