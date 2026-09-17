// npx vitest run services/pii/__tests__/fileVaultRoundTrip.spec.ts
//
// **実質の往復確認。** 実際のディスクへ書き、再起動をまたいで
// 「入 → 読む → 再起動 → 伏せ字が安定」を固定する。
//
// 単体の偽物ではなく、本物のファイル入出力を通す。vscode の fs は node の実ファイルへ
// 差し替える。「再起動」は、新しいコントローラとまっさらな Session Vault を、同じ保存先で
// 作り直して表す。

import * as os from "os"
import * as path from "path"
import { promises as nodefs } from "fs"

import type { AgentMessage, PiiMasking } from "@openai-agent/types"

const disk = vi.hoisted(() => ({ root: "" }))

// ワークスペースのファイルは常に「ある」ことにする（掃除で消させない）。保存先は実ディスク。
vi.mock("vscode", () => {
	const real = (uri: { path: string }) => uri.path
	return {
		window: {
			showInformationMessage: vi.fn(async () => undefined),
			showWarningMessage: vi.fn(async () => undefined),
			showErrorMessage: vi.fn(async () => undefined),
		},
		workspace: {
			getWorkspaceFolder: () => ({ index: 0, uri: { path: "/w" } }),
			get workspaceFolders() {
				return [{ index: 0, uri: { path: "/w" }, name: "w" }]
			},
			onDidRenameFiles: () => ({ dispose() {} }),
			onDidDeleteFiles: () => ({ dispose() {} }),
			asRelativePath: (uri: { path: string }) => uri.path.replace(/^\/w\//, ""),
			fs: {
				async stat(uri: { path: string }) {
					if (uri.path.startsWith("/w/")) return { type: 1 }
					await nodefs.stat(real(uri))
					return { type: 1 }
				},
				async readFile(uri: { path: string }) {
					try {
						return new Uint8Array(await nodefs.readFile(real(uri)))
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							const notFound = new Error(uri.path)
							notFound.name = "FileNotFound"
							throw notFound
						}
						throw error
					}
				},
				async writeFile(uri: { path: string }, value: Uint8Array) {
					await nodefs.mkdir(path.dirname(real(uri)), { recursive: true })
					await nodefs.writeFile(real(uri), value)
				},
				async createDirectory(uri: { path: string }) {
					await nodefs.mkdir(real(uri), { recursive: true })
				},
				async rename(from: { path: string }, to: { path: string }) {
					await nodefs.rename(real(from), real(to))
				},
				async delete(uri: { path: string }) {
					await nodefs.rm(real(uri), { force: true })
				},
			},
		},
		Uri: {
			joinPath(base: { path: string }, ...parts: string[]) {
				return { path: [base.path.replace(/\/$/, ""), ...parts].join("/") }
			},
		},
	}
})

// 第 2 層は試験では読めない。読まない体にする。
vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))
vi.mock("../nerModel", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hasNerRuntime: () => false,
}))
vi.mock("../nerBackend", () => ({
	loadBackend: async () => ({ backend: undefined, check: { ok: false, missing: [], mismatched: [] } }),
	detectWith: async () => [],
}))

import { FileVaultController } from "../fileVault"
import { PiiVault } from "../maskConversation"
import { TaskPiiMasker } from "../TaskPiiMasker"

const uri = (p: string) => ({ path: p })
const controller = () => new FileVaultController({ storageUri: uri(disk.root) } as never)

const readCall = (callId: string, p: string): AgentMessage =>
	({
		type: "function_call",
		call_id: callId,
		name: "read_file",
		arguments: JSON.stringify({ path: p }),
	}) as AgentMessage
const readOutput = (callId: string, text: string): AgentMessage =>
	({ type: "function_call_output", call_id: callId, output: text }) as AgentMessage
const settings: PiiMasking = { enabled: true, kinds: ["email"], fileVault: { enabled: true } }
const masker = () => new TaskPiiMasker(settings, new PiiVault(), controller())

beforeEach(async () => {
	disk.root = await nodefs.mkdtemp(path.join(os.tmpdir(), "file-vault-"))
})
afterEach(async () => {
	await nodefs.rm(disk.root, { recursive: true, force: true })
})

describe("File Vault の往復（実ディスク）", () => {
	it("保存 → 再起動 → 取り込みで、同じ値に同じ伏せ字が当たる", async () => {
		await controller().record(uri("/w/note.md") as never, [["{{email-001}}", "alice@corp.example"]])

		// 再起動: 新しいコントローラとまっさらな Session Vault。保存先は同じ。
		const vault = new PiiVault()
		expect(await controller().prepare(uri("/w/note.md") as never, vault)).toBe(true)
		expect(vault.assign("email", "alice@corp.example")).toBe("{{email-001}}")
		expect(vault.restore("{{email-001}}")).toBe("alice@corp.example")
	})

	it("送信経路: 入で読んだファイルが、再起動後も同じ伏せ字になる", async () => {
		const messages = () => [readCall("c1", "note.md"), readOutput("c1", "連絡先は taro@corp.example")]

		// 起動 A: 読む → 伏せる → 保存。
		const before = await masker().maskForRequest("", messages())
		const out1 = (before.messages.find((m) => m.type === "function_call_output") as { output: string }).output
		expect(out1).toBe("連絡先は {{email-001}}")

		// 起動 B（再起動）: まっさらな Session Vault。同じファイルを読むと、保存済みを取り込んで
		// 同じ伏せ字になる。
		const after = await masker().maskForRequest("", messages())
		const out2 = (after.messages.find((m) => m.type === "function_call_output") as { output: string }).output
		expect(out2).toBe("連絡先は {{email-001}}")
		expect(out2).toBe(out1)
	})

	it("ディスクには実ファイルと .gitignore が残る", async () => {
		await masker().maskForRequest("", [readCall("c1", "note.md"), readOutput("c1", "連絡先は taro@corp.example")])
		const entries = await nodefs.readdir(disk.root)
		expect(entries).toContain("file-vault.v1.json")
		expect(entries).toContain(".gitignore")
		expect(await nodefs.readFile(path.join(disk.root, ".gitignore"), "utf8")).toBe("*\n")
	})
})
