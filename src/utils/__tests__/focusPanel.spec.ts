// npx vitest run utils/__tests__/focusPanel.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("vscode", () => ({
	ViewColumn: { Active: 1 },
	commands: { executeCommand: vi.fn(async () => {}) },
}))

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { sideBarId: "openai-agent.SidebarProvider" },
}))

import * as vscode from "vscode"

import { focusPanel } from "../focusPanel"
import { Package } from "../../shared/package"
import { ClineProvider } from "../../core/webview/ClineProvider"

const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>

/** 最小の tab パネル（reveal と active を持つ）。 */
function makeTabPanel(active: boolean) {
	return { active, reveal: vi.fn() } as unknown as import("vscode").WebviewPanel
}

describe("focusPanel", () => {
	beforeEach(() => {
		executeCommand.mockClear()
	})

	it("パネルが無ければ ActivityBar を開くコマンドを実行する", async () => {
		await focusPanel(undefined, undefined)

		expect(executeCommand).toHaveBeenCalledWith(`workbench.view.extension.${Package.name}-ActivityBar`)
	})

	it("非アクティブな tab パネルは reveal でフォーカスする", async () => {
		const tabPanel = makeTabPanel(false)

		await focusPanel(tabPanel, undefined)

		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledWith(
			vscode.ViewColumn.Active,
			false,
		)
		expect(executeCommand).not.toHaveBeenCalled()
	})

	it("既にアクティブな tab パネルは何もしない", async () => {
		const tabPanel = makeTabPanel(true)

		await focusPanel(tabPanel, undefined)

		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
	})

	it("sidebar パネルのみのときは sidebar の focus コマンドを実行する", async () => {
		const sidebarPanel = {} as unknown as import("vscode").WebviewView

		await focusPanel(undefined, sidebarPanel)

		expect(executeCommand).toHaveBeenCalledWith(`${ClineProvider.sideBarId}.focus`)
	})

	it("tab と sidebar の両方があるときは tab を優先する", async () => {
		const tabPanel = makeTabPanel(false)
		const sidebarPanel = {} as unknown as import("vscode").WebviewView

		await focusPanel(tabPanel, sidebarPanel)

		// tabPanel || sidebarPanel は tabPanel を選ぶため reveal 側が動く。
		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledTimes(1)
		expect(executeCommand).not.toHaveBeenCalled()
	})
})
