import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"
import { createRequire } from "module"

import { ViewsContainer, Views, Menus, Configuration, Keybindings, contributesSchema } from "./types.js"

function copyDir(srcDir: string, dstDir: string, count: number): number {
	const entries = fs.readdirSync(srcDir, { withFileTypes: true })

	for (const entry of entries) {
		const srcPath = path.join(srcDir, entry.name)
		const dstPath = path.join(dstDir, entry.name)

		if (entry.isDirectory()) {
			fs.mkdirSync(dstPath, { recursive: true })
			count = copyDir(srcPath, dstPath, count)
		} else {
			count = count + 1
			fs.copyFileSync(srcPath, dstPath)
		}
	}

	return count
}

function rmDir(dirPath: string, maxRetries: number = 5): void {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isLastAttempt = attempt === maxRetries

			const isRetryableError =
				error instanceof Error &&
				"code" in error &&
				(error.code === "ENOTEMPTY" ||
					error.code === "EBUSY" ||
					error.code === "EPERM" ||
					error.code === "EACCES")

			if (isLastAttempt) {
				// On the last attempt, try alternative cleanup methods.
				try {
					console.warn(`[rmDir] Final attempt using alternative cleanup for ${dirPath}`)

					// Try to clear readonly flags on Windows.
					if (process.platform === "win32") {
						try {
							execSync(`attrib -R "${dirPath}\\*.*" /S /D`, { stdio: "ignore" })
						} catch {
							// Ignore attrib errors.
						}
					}
					fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
					return
				} catch (finalError) {
					console.error(`[rmDir] Failed to remove ${dirPath} after ${maxRetries} attempts:`, finalError)
					throw finalError
				}
			}

			if (!isRetryableError) {
				throw error // Re-throw if it's not a retryable error.
			}

			// Wait with exponential backoff before retrying, with longer delays for Windows.
			const baseDelay = process.platform === "win32" ? 200 : 100
			const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 2000) // Cap at 2s
			console.warn(`[rmDir] Attempt ${attempt} failed for ${dirPath}, retrying in ${delay}ms...`)

			// Synchronous sleep for simplicity in build scripts.
			const start = Date.now()

			while (Date.now() - start < delay) {
				/* Busy wait */
			}
		}
	}
}

type CopyPathOptions = {
	optional?: boolean
}

export function copyPaths(copyPaths: [string, string, CopyPathOptions?][], srcDir: string, dstDir: string) {
	copyPaths.forEach(([srcRelPath, dstRelPath, options = {}]) => {
		try {
			const stats = fs.lstatSync(path.join(srcDir, srcRelPath))

			if (stats.isDirectory()) {
				if (fs.existsSync(path.join(dstDir, dstRelPath))) {
					rmDir(path.join(dstDir, dstRelPath))
				}

				fs.mkdirSync(path.join(dstDir, dstRelPath), { recursive: true })

				const count = copyDir(path.join(srcDir, srcRelPath), path.join(dstDir, dstRelPath), 0)
				console.log(`[copyPaths] Copied ${count} files from ${srcRelPath} to ${dstRelPath}`)
			} else {
				fs.copyFileSync(path.join(srcDir, srcRelPath), path.join(dstDir, dstRelPath))
				console.log(`[copyPaths] Copied ${srcRelPath} to ${dstRelPath}`)
			}
		} catch (error) {
			if (options.optional) {
				console.warn(`[copyPaths] Optional file not found: ${srcRelPath}`)
			} else {
				throw error
			}
		}
	})
}

export function copyWasms(srcDir: string, distDir: string): void {
	const nodeModulesDir = path.join(srcDir, "node_modules")

	fs.mkdirSync(distDir, { recursive: true })

	// Tiktoken WASM file.
	fs.copyFileSync(
		path.join(nodeModulesDir, "tiktoken", "lite", "tiktoken_bg.wasm"),
		path.join(distDir, "tiktoken_bg.wasm"),
	)

	console.log(`[copyWasms] Copied tiktoken WASMs to ${distDir}`)

	// Also copy Tiktoken WASMs to the workers directory.
	const workersDir = path.join(distDir, "workers")
	fs.mkdirSync(workersDir, { recursive: true })

	fs.copyFileSync(
		path.join(nodeModulesDir, "tiktoken", "lite", "tiktoken_bg.wasm"),
		path.join(workersDir, "tiktoken_bg.wasm"),
	)

	console.log(`[copyWasms] Copied tiktoken WASMs to ${workersDir}`)

	// Main tree-sitter WASM file.
	fs.copyFileSync(
		path.join(nodeModulesDir, "web-tree-sitter", "tree-sitter.wasm"),
		path.join(distDir, "tree-sitter.wasm"),
	)

	console.log(`[copyWasms] Copied tree-sitter.wasm to ${distDir}`)

	// Copy language-specific WASM files.
	const languageWasmDir = path.join(nodeModulesDir, "tree-sitter-wasms", "out")

	if (!fs.existsSync(languageWasmDir)) {
		throw new Error(`Directory does not exist: ${languageWasmDir}`)
	}

	// tree-sitter grammars power code-structure parsing (definition extraction / codebase
	// indexing) for the *target project* the agent is opened in. We ship a trimmed set of
	// mainstream languages to keep the bundle small; add an entry here to support more.
	// (A missing language degrades gracefully — that language just isn't parsed.)
	const SUPPORTED_TREE_SITTER_LANGUAGES = new Set([
		"bash",
		"c",
		"c_sharp",
		"cpp",
		"css",
		"embedded_template",
		"go",
		"html",
		"java",
		"javascript",
		"json",
		"kotlin",
		"php",
		"python",
		"ruby",
		"rust",
		"scala",
		"swift",
		"toml",
		"tsx",
		"typescript",
		"vue",
		"yaml",
	])

	const allWasmFiles = fs.readdirSync(languageWasmDir).filter((file) => file.endsWith(".wasm"))
	const wasmFiles = allWasmFiles.filter((file) =>
		SUPPORTED_TREE_SITTER_LANGUAGES.has(file.replace(/^tree-sitter-/, "").replace(/\.wasm$/, "")),
	)

	wasmFiles.forEach((filename) => {
		fs.copyFileSync(path.join(languageWasmDir, filename), path.join(distDir, filename))
	})

	console.log(
		`[copyWasms] Copied ${wasmFiles.length} tree-sitter language wasms to ${distDir} ` +
			`(skipped ${allWasmFiles.length - wasmFiles.length} unsupported)`,
	)
}

export function copyLocales(srcDir: string, distDir: string): void {
	const destDir = path.join(distDir, "i18n", "locales")
	fs.mkdirSync(destDir, { recursive: true })
	const count = copyDir(path.join(srcDir, "i18n", "locales"), destDir, 0)
	console.log(`[copyLocales] Copied ${count} locale files to ${destDir}`)
}

export function setupLocaleWatcher(srcDir: string, distDir: string) {
	const localesDir = path.join(srcDir, "i18n", "locales")

	if (!fs.existsSync(localesDir)) {
		console.warn(`Cannot set up watcher: Source locales directory does not exist: ${localesDir}`)
		return
	}

	console.log(`Setting up watcher for locale files in ${localesDir}`)

	let debounceTimer: NodeJS.Timeout | null = null

	const debouncedCopy = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer)
		}

		// Wait 300ms after last change before copying.
		debounceTimer = setTimeout(() => {
			console.log("Locale files changed, copying...")
			copyLocales(srcDir, distDir)
		}, 300)
	}

	try {
		fs.watch(localesDir, { recursive: true }, (_eventType, filename) => {
			if (filename && filename.endsWith(".json")) {
				console.log(`Locale file ${filename} changed, triggering copy...`)
				debouncedCopy()
			}
		})
		console.log("Watcher for locale files is set up")
	} catch (error) {
		console.error(
			`Error setting up watcher for ${localesDir}:`,
			error instanceof Error ? error.message : "Unknown error",
		)
	}
}

export function generatePackageJson({
	packageJson: { contributes, ...packageJson },
	overrideJson,
	substitution,
}: {
	packageJson: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	overrideJson: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	substitution: [string, string]
}) {
	const { viewsContainers, views, commands, menus, submenus, keybindings, configuration } =
		contributesSchema.parse(contributes)
	const [from, to] = substitution

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result: Record<string, any> = {
		...packageJson,
		...overrideJson,
		contributes: {
			viewsContainers: transformArrayRecord<ViewsContainer>(viewsContainers, from, to, ["id"]),
			views: transformArrayRecord<Views>(views, from, to, ["id"]),
			commands: transformArray(commands, from, to, "command"),
			menus: transformArrayRecord<Menus>(menus, from, to, ["command", "submenu", "when"]),
			submenus: transformArray(submenus, from, to, "id"),
			configuration: {
				title: configuration.title,
				properties: transformRecord<Configuration["properties"]>(configuration.properties, from, to),
			},
		},
	}

	// Only add keybindings if they exist
	if (keybindings) {
		result.contributes.keybindings = transformArray<Keybindings>(keybindings, from, to, "command")
	}

	return result
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformArrayRecord<T>(obj: Record<string, any[]>, from: string, to: string, props: string[]): T {
	return Object.entries(obj).reduce(
		(acc, [key, ary]) => ({
			...acc,
			[key.replaceAll(from, to)]: ary.map((item) => {
				const transformedItem = { ...item }

				for (const prop of props) {
					if (prop in item && typeof item[prop] === "string") {
						transformedItem[prop] = item[prop].replaceAll(from, to)
					}
				}

				return transformedItem
			}),
		}),
		{} as T,
	)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformArray<T>(arr: any[], from: string, to: string, idProp: string): T[] {
	return arr.map(({ [idProp]: id, ...rest }) => ({
		[idProp]: id.replaceAll(from, to),
		...rest,
	}))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformRecord<T>(obj: Record<string, any>, from: string, to: string): T {
	return Object.entries(obj).reduce(
		(acc, [key, value]) => ({
			...acc,
			[key.replaceAll(from, to)]: value,
		}),
		{} as T,
	)
}

/**
 * 第 2 層（固有名詞の検出）が使う実行の仕組みを `dist` へ写す。
 *
 * **なぜ束ねないか。** `onnxruntime-node` は native の実行ファイルを
 * `require(`../bin/napi-v6/${process.platform}/${process.arch}/…`)` で読む。束ねると
 * この相対の位置が `dist` を基準に解決され、実行ファイルが見つからない。
 *
 * **なぜ `dist/node_modules` なのか。** VSIX は `--no-dependencies` で作るので、
 * `node_modules` は同梱されない。`dist/extension.js` から `onnxruntime-node` を要求すると、
 * Node は `dist/node_modules` を見に行く。そこに置けば解決できる。
 *
 * **GPU 用は写さない。** CUDA だけで 302 MB あり、判定は CPU で 21 ms で終わる
 * （`docs/features/pii-proper-nouns.md`）。
 *
 * @param target 配る先。`linux-x64` の形。省略すると、いま動いている環境に合わせる
 */
export function copyOnnxRuntime(srcDir: string, distDir: string, target?: string): void {
	const [platform, arch] = (target ?? `${process.platform}-${process.arch}`).split("-")

	// **失敗を握り潰さない。** 写せていないまま VSIX を作ると、第 2 層が動かないのに
	// 画面上は何も変わらず、原因の分からない不具合になる。
	const roots = resolveRuntimeRoots(srcDir)

	const dest = path.join(distDir, "node_modules")

	// 判定そのものを実行するもの。platform ごとに 1 つだけ写す。
	copyPackage(roots.node, path.join(dest, "onnxruntime-node"), (relative) => {
		if (relative.startsWith("dist/") || relative === "package.json") return true
		if (!relative.startsWith(`bin/napi-v6/${platform}/${arch}/`)) return false
		// GPU 用。同梱しても使わない。
		return !/cuda|tensorrt|DirectML|dxcompiler|dxil/i.test(relative)
	})

	// `onnxruntime-node` が実行時に要求する。型と少量の JavaScript だけである。
	copyPackage(roots.common, path.join(dest, "onnxruntime-common"), (relative) =>
		relative.startsWith("dist/") || relative === "package.json",
	)

	console.log(`[copyOnnxRuntime] Copied onnxruntime for ${platform}-${arch} to ${dest}`)
}

/**
 * `onnxruntime-node` と `onnxruntime-common` の場所を解く。pnpm の配置に依らない。
 *
 * **`require.resolve` は使えない。** この module は ESM として読み込まれるので、
 * `require` が無い。`srcDir` を基点に `createRequire` を作る。
 */
function resolveRuntimeRoots(srcDir: string): { node: string; common: string } {
	const fromSrc = createRequire(path.join(srcDir, "package.json"))
	const req = createRequire(fromSrc.resolve("@huggingface/transformers"))

	// **`onnxruntime-common` は `onnxruntime-node` から解く。** `@huggingface/transformers`
	// は `onnxruntime-common` を依存として宣言していないので、そちらから解くと、入れ方に
	// よっては見つからないか、**`onnxruntime-node` が要求するのと違う版**を拾う。
	const node = packageRoot(req.resolve("onnxruntime-node"), "onnxruntime-node")
	const fromNode = createRequire(path.join(node, "package.json"))

	return { node, common: packageRoot(fromNode.resolve("onnxruntime-common"), "onnxruntime-common") }
}

/**
 * 入口のファイルから、そのパッケージの根を辿る。
 *
 * `package.json` は `exports` に載っていないことがあるので、直接は解決できない。
 * `name` が一致する `package.json` に当たるまで上へ辿る。
 */
function packageRoot(entry: string, name: string): string {
	let dir = path.dirname(entry)
	for (let depth = 0; depth < 10; depth++) {
		const manifest = path.join(dir, "package.json")
		if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) return dir
		dir = path.dirname(dir)
	}

	throw new Error(`${name} の根が見つからない: ${entry}`)
}

/** `keep` が真を返すファイルだけを写す。相対パスは `/` で区切る。 */
function copyPackage(from: string, to: string, keep: (relative: string) => boolean): void {
	for (const entry of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue

		const full = path.join(entry.parentPath ?? entry.path, entry.name)
		const relative = path.relative(from, full).split(path.sep).join("/")
		if (!keep(relative)) continue

		const target = path.join(to, relative)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.copyFileSync(full, target)
	}
}
