// npx vitest run utils/__tests__/commands.spec.ts

import { describe, it, expect } from "vitest"

import { getCommand, getCodeActionCommand, getTerminalCommand } from "../commands"
import { Package } from "../../shared/package"

describe("commands id helpers", () => {
	it("getCommand は `<publisher.name>.<id>` を組み立てる", () => {
		expect(getCommand("newTask" as any)).toBe(`${Package.name}.newTask`)
	})

	it("getCodeActionCommand も Package.name を接頭辞にする", () => {
		expect(getCodeActionCommand("explainCode" as any)).toBe(`${Package.name}.explainCode`)
	})

	it("getTerminalCommand も Package.name を接頭辞にする", () => {
		expect(getTerminalCommand("addToContext" as any)).toBe(`${Package.name}.addToContext`)
	})

	it("id をそのまま末尾に連結する（余計な加工をしない）", () => {
		// ハイフンやドットを含む id でも素通しであることを固定する。
		expect(getCommand("some-weird.id" as any)).toBe(`${Package.name}.some-weird.id`)
	})
})
