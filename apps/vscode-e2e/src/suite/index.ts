import * as path from "path"
import Mocha from "mocha"
import { glob } from "glob"
import * as vscode from "vscode"

import type { AgentAPI } from "@openai-agent/types"

import { waitFor } from "./utils"
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fakeOpenAiServer"

export async function run() {
	// Works whether VS Code loads the dev extension (src → "internal.openai-agent") or the built
	// internal extension (→ "internal.openai-compatible-agent"). The command/view prefix equals the
	// loaded extension's package name, so we derive it rather than hard-coding it.
	const extension =
		vscode.extensions.getExtension<AgentAPI>("internal.openai-compatible-agent") ??
		vscode.extensions.getExtension<AgentAPI>("internal.openai-agent")

	if (!extension) {
		throw new Error("Extension not found")
	}

	const commandPrefix: string = extension.packageJSON.name
	globalThis.commandPrefix = commandPrefix

	const api = extension.isActive ? extension.exports : await extension.activate()

	// OPENAI_BASE_URL が明示されていれば実エンドポイントを使う（鍵を置いて回す用途）。
	// 指定が無ければフェイクの OpenAI 互換サーバを立てる。これにより鍵なしでも
	// 「拡張 → HTTP → ストリーム解釈 → タスクループ → UI」を決定論的に 1 往復できる。
	let fakeServer: FakeOpenAiServer | undefined

	if (!process.env.OPENAI_BASE_URL) {
		fakeServer = await startFakeOpenAiServer()
		globalThis.fakeOpenAiServer = fakeServer
	}

	await api.setConfiguration({
		apiProvider: "openai" as const,
		openAiBaseUrl: fakeServer?.url ?? process.env.OPENAI_BASE_URL!,
		openAiApiKey: process.env.OPENAI_API_KEY ?? "mock",
		openAiModelId: process.env.OPENAI_MODEL_ID ?? "mock-model",
	})

	await vscode.commands.executeCommand(`${commandPrefix}.SidebarProvider.focus`)
	await waitFor(() => api.isReady())

	globalThis.api = api

	const mochaOptions: Mocha.MochaOptions = {
		ui: "tdd",
		timeout: 20 * 60 * 1_000, // 20m
	}

	if (process.env.TEST_GREP) {
		mochaOptions.grep = process.env.TEST_GREP
		console.log(`Running tests matching pattern: ${process.env.TEST_GREP}`)
	}

	const mocha = new Mocha(mochaOptions)
	const cwd = path.resolve(__dirname, "..")

	let testFiles: string[]

	if (process.env.TEST_FILE) {
		// カンマ区切りで複数指定できる（例: extension.test.js,round-trip.test.js）。
		const specificFiles = process.env.TEST_FILE.split(",")
			.map((name) => name.trim())
			.filter(Boolean)
			.map((name) => (name.endsWith(".js") ? name : `${name}.js`))

		testFiles = (await Promise.all(specificFiles.map((name) => glob(`**/${name}`, { cwd })))).flat()
		console.log(`Running specific test files: ${specificFiles.join(", ")}`)
	} else {
		testFiles = await glob("**/**.test.js", { cwd })
	}

	if (testFiles.length === 0) {
		throw new Error(`No test files found matching criteria: ${process.env.TEST_FILE || "all tests"}`)
	}

	testFiles.forEach((testFile) => mocha.addFile(path.resolve(cwd, testFile)))

	try {
		await new Promise<void>((resolve, reject) =>
			mocha.run((failures) => (failures === 0 ? resolve() : reject(new Error(`${failures} tests failed.`)))),
		)
	} finally {
		await fakeServer?.close()
	}
}
