import path, { resolve } from "path"
import fs from "fs"
import { execSync } from "child_process"

import { defineConfig, type PluginOption, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { sourcemapPlugin } from "./src/vite-plugins/sourcemapPlugin"

function getGitSha() {
	let gitSha: string | undefined = undefined

	try {
		gitSha = execSync("git rev-parse HEAD").toString().trim()
	} catch (_error) {
		// Do nothing.
	}

	return gitSha
}

const wasmPlugin = (): Plugin => ({
	name: "wasm",
	async load(id) {
		if (id.endsWith(".wasm")) {
			const wasmBinary = await import(id)

			return `
           			const wasmModule = new WebAssembly.Module(${wasmBinary.default});
           			export default wasmModule;
         		`
		}
	},
})

const persistPortPlugin = (): Plugin => ({
	name: "write-port-to-file",
	configureServer(viteDevServer) {
		viteDevServer?.httpServer?.once("listening", () => {
			const address = viteDevServer?.httpServer?.address()
			const port = address && typeof address === "object" ? address.port : null

			if (port) {
				fs.writeFileSync(resolve(__dirname, "..", ".vite-port"), port.toString())
				console.log(`[Vite Plugin] Server started on port ${port}`)
			} else {
				console.warn("[Vite Plugin] Could not determine server port")
			}
		})
	},
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	let outDir = "../src/webview-ui/build"

	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "package.json"), "utf8"))
	const gitSha = getGitSha()

	const define: Record<string, any> = {
		"process.platform": JSON.stringify(process.platform),
		"process.env.VSCODE_TEXTMATE_DEBUG": JSON.stringify(process.env.VSCODE_TEXTMATE_DEBUG),
		"process.env.PKG_NAME": JSON.stringify(pkg.name),
		"process.env.PKG_VERSION": JSON.stringify(pkg.version),
		"process.env.PKG_OUTPUT_CHANNEL": JSON.stringify("OpenAI-Agent"),
		...(gitSha ? { "process.env.PKG_SHA": JSON.stringify(gitSha) } : {}),
	}

	// TODO: We can use `@openai-agent/build` to generate `define` once the
	// monorepo is deployed.
	if (mode === "nightly") {
		outDir = "../apps/vscode-nightly/build/webview-ui/build"

		const nightlyPkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "apps", "vscode-nightly", "package.nightly.json"), "utf8"),
		)

		define["process.env.PKG_NAME"] = JSON.stringify(nightlyPkg.name)
		define["process.env.PKG_VERSION"] = JSON.stringify(nightlyPkg.version)
		define["process.env.PKG_OUTPUT_CHANNEL"] = JSON.stringify("OpenAI-Agent-Nightly")
	}

	if (mode === "internal") {
		outDir = "../apps/vscode-internal/build/webview-ui/build"

		const internalPkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "apps", "vscode-internal", "package.internal.json"), "utf8"),
		)

		define["process.env.PKG_NAME"] = JSON.stringify(internalPkg.name)
		define["process.env.PKG_VERSION"] = JSON.stringify(internalPkg.version)
		define["process.env.PKG_OUTPUT_CHANNEL"] = JSON.stringify("Local-Agent")
	}

	// Distributed builds (internal / nightly .vsix): ship minified, no source maps.
	const isLeanBuild = mode === "internal" || mode === "nightly"

	const plugins: PluginOption[] = [
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", { target: "18" }]],
			},
		}),
		tailwindcss(),
		persistPortPlugin(),
		wasmPlugin(),
		// The sourcemap plugin force-copies .map files into the build; skip it for lean builds.
		...(isLeanBuild ? [] : [sourcemapPlugin()]),
	]

	return {
		plugins,
		resolve: {
			alias: {
				"@": resolve(__dirname, "./src"),
				"@src": resolve(__dirname, "./src"),
				"@agent": resolve(__dirname, "../src/shared"),
			},
		},
		build: {
			outDir,
			emptyOutDir: true,
			reportCompressedSize: false,
			// Source maps for dev/debug builds only; distributed .vsix builds ship without them.
			sourcemap: !isLeanBuild,
			// Minify production and distributed (internal / nightly) builds.
			minify: mode === "production" || isLeanBuild ? "esbuild" : false,
			// Use a single combined CSS bundle so all webviews share styles
			cssCodeSplit: false,
			rollupOptions: {
				// Externalize vscode module - it's imported by file-search.ts which is
				// dynamically imported by agent-config/index.ts, but should never be bundled
				// in the webview since it's not available in the browser context
				external: ["vscode"],
				input: {
					index: resolve(__dirname, "index.html"),
				},
				output: {
					entryFileNames: `assets/[name].js`,
					chunkFileNames: (chunkInfo) => {
						if (chunkInfo.name === "mermaid-bundle") {
							return `assets/mermaid-bundle.js`
						}
						// Default naming for other chunks, ensuring uniqueness from entry
						return `assets/chunk-[hash].js`
					},
					assetFileNames: (assetInfo) => {
						const name = assetInfo.name || ""

						// Force all CSS into a single predictable file used by both webviews
						if (name.endsWith(".css")) {
							return "assets/index.css"
						}

						if (name.endsWith(".woff2") || name.endsWith(".woff") || name.endsWith(".ttf")) {
							return "assets/fonts/[name][extname]"
						}
						// Ensure source maps are included in the build
						if (name.endsWith(".map")) {
							return "assets/[name]"
						}
						return "assets/[name][extname]"
					},
					manualChunks: (id, { getModuleInfo }) => {
						// Consolidate all mermaid code and its direct large dependencies (like dagre)
						// into a single chunk. The 'channel.js' error often points to dagre.
						if (
							id.includes("node_modules/mermaid") ||
							id.includes("node_modules/dagre") || // dagre is a common dep for graph layout
							id.includes("node_modules/cytoscape") // another potential graph lib
							// Add other known large mermaid dependencies if identified
						) {
							return "mermaid-bundle"
						}

						// Check if the module is part of any explicitly defined mermaid-related dynamic import
						// This is a more advanced check if simple path matching isn't enough.
						const moduleInfo = getModuleInfo(id)
						if (moduleInfo?.importers.some((importer) => importer.includes("node_modules/mermaid"))) {
							return "mermaid-bundle"
						}
						if (
							moduleInfo?.dynamicImporters.some((importer) => importer.includes("node_modules/mermaid"))
						) {
							return "mermaid-bundle"
						}
					},
				},
			},
		},
		server: {
			hmr: {
				host: "localhost",
				protocol: "ws",
			},
			cors: {
				origin: "*",
				methods: "*",
				allowedHeaders: "*",
			},
		},
		define,
		optimizeDeps: {
			include: [
				"mermaid",
				"dagre", // Explicitly include dagre for pre-bundling
				// Add other known large mermaid dependencies if identified
			],
			exclude: ["@vscode/codicons", "vscode-oniguruma", "shiki"],
		},
		assetsInclude: ["**/*.wasm", "**/*.wav"],
	}
})
