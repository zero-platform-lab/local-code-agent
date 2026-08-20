// npx vitest run src/__tests__/index.test.ts

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { generatePackageJson } from "../index.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

describe("internal build package.json contribution IDs", () => {
	// Guards against the class of bug where the VS Code extension's contributed command /
	// view / config IDs no longer match the runtime `Package.name` (the IDs the code registers
	// via `${Package.name}.*`). When that happens buttons resolve to "command not found" and the
	// sidebar view has no provider — which unit tests (that mock vscode entirely) cannot catch.
	it("renames every contribution ID to the runtime extension name (openai-compatible-agent)", () => {
		const srcPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "src/package.json"), "utf8"))
		const overrideJson = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "apps/vscode-internal/package.internal.json"), "utf8"),
		)
		const esbuild = fs.readFileSync(path.join(repoRoot, "apps/vscode-internal/esbuild.mjs"), "utf8")

		// Use the *exact* substitution and runtime PKG_NAME the internal build ships with, so a
		// misconfigured esbuild (e.g. a stale substitution `from`) is caught here rather than at runtime.
		const subMatch = esbuild.match(/substitution:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/)
		const pkgNameMatch = esbuild.match(/"process\.env\.PKG_NAME":\s*'"([^"]+)"'/)
		expect(subMatch, "substitution not found in esbuild.mjs").toBeTruthy()
		expect(pkgNameMatch, "PKG_NAME define not found in esbuild.mjs").toBeTruthy()
		const from = subMatch![1]!
		const to = subMatch![2]!
		const runtimeName = pkgNameMatch![1]!

		const result = generatePackageJson({ packageJson: srcPackageJson, overrideJson, substitution: [from, to] })
		const contributes = JSON.stringify(result.contributes)

		// The shipped extension name must equal the runtime Package.name, otherwise the code
		// registers `${runtimeName}.*` while the manifest advertises a different id.
		expect(result.name).toBe(runtimeName)

		// No contribution ID may retain the source-package prefix (the exact regression that broke
		// the settings button and looped the sidebar on first launch).
		expect(contributes).not.toContain(`${srcPackageJson.name}.`)
		expect(contributes).not.toContain(`${srcPackageJson.name}-ActivityBar`)

		// Every contributed command / view / view-container / config key uses the runtime prefix.
		for (const c of result.contributes.commands ?? []) {
			expect(c.command.startsWith(`${runtimeName}.`), `command ${c.command}`).toBe(true)
		}
		for (const [container, views] of Object.entries(result.contributes.views ?? {})) {
			expect(container.startsWith(`${runtimeName}-`), `view container ${container}`).toBe(true)
			for (const v of views as Array<{ id: string }>) {
				expect(v.id.startsWith(`${runtimeName}.`), `view ${v.id}`).toBe(true)
			}
		}
		for (const key of Object.keys(result.contributes.configuration?.properties ?? {})) {
			expect(key.startsWith(`${runtimeName}.`), `config key ${key}`).toBe(true)
		}

		// Spot-check the two IDs behind the reported bugs.
		expect(contributes).toContain(`${runtimeName}.settingsButtonClicked`)
		expect(contributes).toContain(`${runtimeName}.SidebarProvider`)
	})
})

describe("generatePackageJson", () => {
	it("should be a test", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "openai-agent",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "internal",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "openai-agent-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"openai-agent-ActivityBar": [
							{
								type: "webview",
								id: "openai-agent.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "openai-agent.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "openai-agent.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "openai-agent.contextMenu",
								group: "navigation",
							},
						],
						"openai-agent.contextMenu": [
							{
								command: "openai-agent.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "openai-agent.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == openai-agent.TabPanelProvider",
							},
							{
								command: "openai-agent.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == openai-agent.TabPanelProvider",
							},
							{
								command: "openai-agent.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == openai-agent.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "openai-agent.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "openai-agent.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"openai-agent.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"openai-agent.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "openai-agent-nightly",
				displayName: "OpenAI Agent Nightly",
				publisher: "internal",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["openai-agent", "openai-agent-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "openai-agent-nightly",
			displayName: "OpenAI Agent Nightly",
			description: "%extension.description%",
			publisher: "internal",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "openai-agent-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"openai-agent-nightly-ActivityBar": [
						{
							type: "webview",
							id: "openai-agent-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "openai-agent-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "openai-agent-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "openai-agent-nightly.contextMenu",
							group: "navigation",
						},
					],
					"openai-agent-nightly.contextMenu": [
						{
							command: "openai-agent-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "openai-agent-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == openai-agent-nightly.TabPanelProvider",
						},
						{
							command: "openai-agent-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == openai-agent-nightly.TabPanelProvider",
						},
						{
							command: "openai-agent-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == openai-agent-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "openai-agent-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "openai-agent-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"openai-agent-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"openai-agent-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
					},
				},
			},
			scripts: {},
		})
	})
})
