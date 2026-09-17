// npx vitest run services/pii/__tests__/TaskPiiMaskerFileMapping.spec.ts
//
// 送信経路の ファイル対応表の配線。読んだファイルを、伏せる前に取り込み、伏せた後に保存する。

import type { AgentMessage } from "@openai-agent/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))

// 第 2 層（固有名詞）のモデルは試験では読めない。読まない体にして、第 1 層だけを見る。
vi.mock("../nerModel", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasNerRuntime: () => false,
}))
vi.mock("../nerBackend", () => ({
	loadBackend: async () => ({ backend: undefined, check: { ok: false, missing: [], mismatched: [] } }),
	detectWith: async () => [],
}))

import type { FileMappingController } from "../fileMapping"
import { resetSessionMapping } from "../maskConversation"
import { TaskPiiMasker } from "../TaskPiiMasker"

// 対応表は本製品で 1 つを共有する。捨てないと前の試験の番号が残る。
beforeEach(() => resetSessionMapping())

function fakeMapping() {
	return {
		prepareToolPath: vi.fn(async (_path: string, _mapping: unknown) => (text: string) => text),
		recordToolPath: vi.fn(async (_path: string, _entries: unknown) => true),
	}
}

const readCall = (callId: string, args: unknown): AgentMessage =>
	({ type: "function_call", call_id: callId, name: "read_file", arguments: JSON.stringify(args) }) as AgentMessage
const readOutput = (callId: string, text: string): AgentMessage =>
	({ type: "function_call_output", call_id: callId, output: text }) as AgentMessage

const masker = (fileMapping: FileMappingController | undefined) =>
	new TaskPiiMasker({ enabled: true, kinds: ["email"], fileMapping: { enabled: true } }, undefined, fileMapping)

describe("TaskPiiMasker と ファイル対応表の配線", () => {
	it("読んだファイルを、伏せる前に取り込み、伏せた後に保存する", async () => {
		const fake = fakeMapping()
		const result = await masker(fake as unknown as FileMappingController).maskForRequest("", [
			readCall("c1", { path: "note.md" }),
			readOutput("c1", "連絡先は taro@corp.example"),
		])

		const out = result.messages.find((item) => item.type === "function_call_output") as { output: string }
		expect(out.output).toBe("連絡先は {{email-001}}")
		expect(fake.prepareToolPath).toHaveBeenCalledWith("note.md", expect.anything())
		expect(fake.recordToolPath).toHaveBeenCalledWith("note.md", [["{{email-001}}", "taro@corp.example"]])
	})

	it("取り込みは伏せる前、保存は伏せた後の順で呼ぶ", async () => {
		const order: string[] = []
		const fake = {
			prepareToolPath: vi.fn(async () => {
				order.push("prepare")
				return (text: string) => text
			}),
			recordToolPath: vi.fn(async () => {
				order.push("record")
				return true
			}),
		}
		await masker(fake as unknown as FileMappingController).maskForRequest("", [
			readCall("c1", { path: "note.md" }),
			readOutput("c1", "taro@corp.example"),
		])
		expect(order).toEqual(["prepare", "record"])
	})

	it("同じファイルは、タスク内で一度だけ取り込む/保存する", async () => {
		const fake = fakeMapping()
		const one = masker(fake as unknown as FileMappingController)
		const messages = [readCall("c1", { path: "note.md" }), readOutput("c1", "連絡先は taro@corp.example")]
		await one.maskForRequest("", messages)
		await one.maskForRequest("", messages)
		expect(fake.prepareToolPath).toHaveBeenCalledTimes(1)
		expect(fake.recordToolPath).toHaveBeenCalledTimes(1)
	})

	it("複数ファイルの読みは取り込むが、保存はしない（切り分けられないため）", async () => {
		const fake = fakeMapping()
		await masker(fake as unknown as FileMappingController).maskForRequest("", [
			readCall("c1", { files: [{ path: "a.md" }, { path: "b.md" }] }),
			readOutput("c1", "連絡先は taro@corp.example"),
		])
		expect(fake.prepareToolPath).toHaveBeenCalledWith("a.md", expect.anything())
		expect(fake.prepareToolPath).toHaveBeenCalledWith("b.md", expect.anything())
		expect(fake.recordToolPath).not.toHaveBeenCalled()
	})

	it("伏せ字が無いファイルは保存しない", async () => {
		const fake = fakeMapping()
		await masker(fake as unknown as FileMappingController).maskForRequest("", [
			readCall("c1", { path: "note.md" }),
			readOutput("c1", "ふつうの本文"),
		])
		expect(fake.recordToolPath).not.toHaveBeenCalled()
	})

	it("コントローラが無ければ、伏せ字化は従来どおり動く", async () => {
		const result = await masker(undefined).maskForRequest("", [
			readCall("c1", { path: "note.md" }),
			readOutput("c1", "taro@corp.example"),
		])
		const out = result.messages.find((item) => item.type === "function_call_output") as { output: string }
		expect(out.output).toBe("{{email-001}}")
	})

	it("ファイル対応表がオフなら、コントローラがあっても呼ばない", async () => {
		const fake = fakeMapping()
		const off = new TaskPiiMasker(
			{ enabled: true, kinds: ["email"], fileMapping: { enabled: false } },
			undefined,
			fake as unknown as FileMappingController,
		)
		await off.maskForRequest("", [readCall("c1", { path: "note.md" }), readOutput("c1", "taro@corp.example")])
		expect(fake.prepareToolPath).not.toHaveBeenCalled()
		expect(fake.recordToolPath).not.toHaveBeenCalled()
	})
})
