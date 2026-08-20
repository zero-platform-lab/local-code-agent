import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { getGitSha, copyPaths, copyWasms, generatePackageJson } from "@openai-agent/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function patchBranding(text) {
	return text
		.replaceAll("RooCodeStorage", "AgentStorage")
		.replaceAll("roo-code-settings", "agent-settings")
		.replaceAll("Roo Code", "Local Agent")
		.replaceAll("RooCode", "Local-Agent")
		.replaceAll("Roo Cline", "Local Agent")
		.replace(/\bRoo\b/g, "Agent")
}

async function main() {
	const name = "extension-internal"
	const production = process.argv.includes("--production")
	const minify = production
	const sourcemap = !production

	const overrideJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.internal.json"), "utf8"))
	console.log(`[${name}] name: ${overrideJson.name}`)
	console.log(`[${name}] version: ${overrideJson.version}`)

	const gitSha = getGitSha()
	console.log(`[${name}] gitSha: ${gitSha}`)

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
		define: {
			"process.env.PKG_PUBLISHER": '"internal"',
			"process.env.PKG_NAME": '"openai-compatible-agent"',
			"process.env.PKG_VERSION": `"${overrideJson.version}"`,
			"process.env.PKG_OUTPUT_CHANNEL": '"Local-Agent"',
			...(gitSha ? { "process.env.PKG_SHA": `"${gitSha}"` } : {}),
		},
	}

	const srcDir = path.join(__dirname, "..", "..", "src")
	const buildDir = path.join(__dirname, "build")
	const distDir = path.join(buildDir, "dist")

	console.log(`[${name}] srcDir: ${srcDir}`)
	console.log(`[${name}] buildDir: ${buildDir}`)
	console.log(`[${name}] distDir: ${distDir}`)

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		fs.rmSync(distDir, { recursive: true, force: true })
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyPaths",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../LICENSE", "LICENSE"],
							["../.env", ".env", { optional: true }],
							[".vscodeignore", ".vscodeignore"],
							["assets", "assets"],
							["integrations", "integrations"],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "generatePackageJson",
			setup(build) {
				build.onEnd(() => {
					const packageJson = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8"))

					const generatedPackageJson = generatePackageJson({
						packageJson,
						overrideJson,
						// Rewrite the contribution ID prefix (commands / views / config keys) to match the
						// runtime extension name (Package.name === "openai-compatible-agent", injected via
						// PKG_NAME). Without this the menu/command/view IDs stay "openai-agent.*" while the
						// code registers "openai-compatible-agent.*", so buttons resolve to "command not found".
						substitution: ["openai-agent", "openai-compatible-agent"],
					})

					const pkgStr = JSON.stringify(generatedPackageJson, null, 2)
					fs.writeFileSync(path.join(buildDir, "package.json"), pkgStr)
					console.log(`[generatePackageJson] Generated package.json`)

					const allowedNls = ["package.nls.json", "package.nls.ja.json"]
					let count = 0

					fs.readdirSync(path.join(srcDir)).forEach((file) => {
						if (file.startsWith("package.nls") && allowedNls.includes(file)) {
							fs.copyFileSync(path.join(srcDir, file), path.join(buildDir, file))
							count++
						}
					})

					console.log(`[generatePackageJson] Copied ${count} package.nls*.json files to ${buildDir}`)

					const nlsInternalPkg = JSON.parse(
						fs.readFileSync(path.join(__dirname, "package.nls.internal.json"), "utf8"),
					)

					const patchNls = (obj) => {
						const patched = {}
						for (const [key, val] of Object.entries(obj)) {
							if (typeof val === "string") {
								patched[key] = patchBranding(val)
							} else {
								patched[key] = val
							}
						}
						return patched
					}

					for (const nlsFile of allowedNls) {
						const srcPath = path.join(srcDir, nlsFile)
						if (fs.existsSync(srcPath)) {
							let nlsData = JSON.parse(fs.readFileSync(srcPath, "utf8"))
							nlsData = patchNls(nlsData)
							if (nlsFile === "package.nls.json") {
								nlsData = { ...nlsData, ...nlsInternalPkg }
							}
							fs.writeFileSync(path.join(buildDir, nlsFile), JSON.stringify(nlsData, null, 2))
						}
					}

					console.log(`[generatePackageJson] Generated NLS files`)
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
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => {
					const allowedLocales = ["en", "ja"]
					const srcLocalesDir = path.join(srcDir, "i18n", "locales")
					const destLocalesDir = path.join(distDir, "i18n", "locales")

					for (const locale of allowedLocales) {
						const srcLocaleDir = path.join(srcLocalesDir, locale)
						const destLocaleDir = path.join(destLocalesDir, locale)
						if (fs.existsSync(srcLocaleDir)) {
							fs.mkdirSync(destLocaleDir, { recursive: true })
							for (const file of fs.readdirSync(srcLocaleDir)) {
								let content = fs.readFileSync(path.join(srcLocaleDir, file), "utf8")
								content = patchBranding(content)
								fs.writeFileSync(path.join(destLocaleDir, file), content)
							}
						}
					}
					console.log(`[copyLocales] Copied and patched locales: ${allowedLocales.join(", ")}`)
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionBuildOptions = {
		...buildOptions,
		plugins,
		entryPoints: [path.join(srcDir, "extension.ts")],
		outfile: path.join(distDir, "extension.js"),
		external: ["vscode"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerBuildOptions = {
		...buildOptions,
		entryPoints: [path.join(srcDir, "workers", "countTokens.ts")],
		outdir: path.join(distDir, "workers"),
	}

	const [extensionBuildContext, workerBuildContext] = await Promise.all([
		esbuild.context(extensionBuildOptions),
		esbuild.context(workerBuildOptions),
	])

	await Promise.all([
		extensionBuildContext.rebuild(),
		extensionBuildContext.dispose(),

		workerBuildContext.rebuild(),
		workerBuildContext.dispose(),
	])
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
