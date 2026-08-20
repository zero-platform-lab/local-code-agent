// npx vitest run packages/core/src/message-utils/__tests__/consolidateCommands.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { consolidateCommands, COMMAND_OUTPUT_STRING } from "../consolidateCommands.js"

describe("consolidateCommands", () => {
	describe("command sequences", () => {
		it("should consolidate command and command_output messages", () => {
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "command", text: "ls", ts: 1000 },
				{ type: "ask", ask: "command_output", text: "file1.txt", ts: 1001 },
				{ type: "ask", ask: "command_output", text: "file2.txt", ts: 1002 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(result[0]!.ask).toBe("command")
			expect(result[0]!.text).toBe(`ls\n${COMMAND_OUTPUT_STRING}file1.txt\nfile2.txt`)
		})

		it("should handle multiple command sequences", () => {
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "command", text: "ls", ts: 1000 },
				{ type: "ask", ask: "command_output", text: "output1", ts: 1001 },
				{ type: "ask", ask: "command", text: "pwd", ts: 1002 },
				{ type: "ask", ask: "command_output", text: "output2", ts: 1003 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(2)
			expect(result[0]!.text).toBe(`ls\n${COMMAND_OUTPUT_STRING}output1`)
			expect(result[1]!.text).toBe(`pwd\n${COMMAND_OUTPUT_STRING}output2`)
		})

		it("should handle command without output", () => {
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "command", text: "ls", ts: 1000 },
				{ type: "say", say: "text", text: "some text", ts: 1001 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(2)
			expect(result[0]!.ask).toBe("command")
			expect(result[0]!.text).toBe("ls")
			expect(result[1]!.say).toBe("text")
		})

		it("should handle duplicate outputs (ask and say with same text)", () => {
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "command", text: "ls", ts: 1000 },
				{ type: "ask", ask: "command_output", text: "same output", ts: 1001 },
				{ type: "say", say: "command_output", text: "same output", ts: 1002 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(result[0]!.text).toBe(`ls\n${COMMAND_OUTPUT_STRING}same output`)
		})
	})

	describe("MCP server sequences", () => {
		it("should consolidate use_mcp_server and mcp_server_response messages", () => {
			const messages: ClineMessage[] = [
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({ server: "test", tool: "myTool" }),
					ts: 1000,
				},
				{ type: "say", say: "mcp_server_response", text: "response data", ts: 1001 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(result[0]!.ask).toBe("use_mcp_server")
			const parsed = JSON.parse(result[0]!.text || "{}")
			expect(parsed.server).toBe("test")
			expect(parsed.response).toBe("response data")
		})

		it("should handle MCP request without response", () => {
			const messages: ClineMessage[] = [
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({ server: "test" }),
					ts: 1000,
				},
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(result[0]!.ask).toBe("use_mcp_server")
		})

		it("should handle multiple MCP responses", () => {
			const messages: ClineMessage[] = [
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({ server: "test" }),
					ts: 1000,
				},
				{ type: "say", say: "mcp_server_response", text: "response1", ts: 1001 },
				{ type: "say", say: "mcp_server_response", text: "response2", ts: 1002 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			const parsed = JSON.parse(result[0]!.text || "{}")
			expect(parsed.response).toBe("response1\nresponse2")
		})
	})

	describe("mixed messages", () => {
		it("should preserve non-command, non-MCP messages", () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "text", text: "before", ts: 1000 },
				{ type: "ask", ask: "command", text: "ls", ts: 1001 },
				{ type: "ask", ask: "command_output", text: "output", ts: 1002 },
				{ type: "say", say: "text", text: "after", ts: 1003 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(3)
			expect(result[0]!.text).toBe("before")
			expect(result[1]!.text).toBe(`ls\n${COMMAND_OUTPUT_STRING}output`)
			expect(result[2]!.text).toBe("after")
		})

		it("should handle empty array", () => {
			const result = consolidateCommands([])
			expect(result).toEqual([])
		})
	})

	describe("分岐網羅の補完", () => {
		it("MCP スキャン中の穴・無関係メッセージを飛ばして応答だけ取り込む", () => {
			// index1 は穴（!nextMsg）、index2 は応答でも別 MCP でもない say（else の j++）。
			const messages: ClineMessage[] = []
			messages[0] = { type: "ask", ask: "use_mcp_server", text: JSON.stringify({ server: "s" }), ts: 1000 }
			messages[2] = { type: "say", say: "text", text: "interleaved", ts: 1002 }
			messages[3] = { type: "say", say: "mcp_server_response", text: "resp", ts: 1003 }
			messages.length = 4

			const result = consolidateCommands(messages)

			// 統合された MCP メッセージ + 間に挟まった text の 2 件
			expect(result.length).toBe(2)
			const mcp = result.find((m) => m.ask === "use_mcp_server")!
			expect(JSON.parse(mcp.text || "{}").response).toBe("resp")
			expect(result.some((m) => m.text === "interleaved")).toBe(true)
		})

		it("連続する use_mcp_server は 2 件目で走査を打ち切りどちらも原文で残す", () => {
			// index1 が別の use_mcp_server → break（応答なし扱い）
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "use_mcp_server", text: JSON.stringify({ server: "a" }), ts: 1000 },
				{ type: "ask", ask: "use_mcp_server", text: JSON.stringify({ server: "b" }), ts: 1001 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(2)
			// 応答が無いので response フィールドは付かない
			expect(JSON.parse(result[0]!.text || "{}").response).toBeUndefined()
			expect(JSON.parse(result[1]!.text || "{}").response).toBeUndefined()
		})

		it("応答メッセージの text が空でも空文字として取り込む", () => {
			// `nextMsg.text || ""` の "" 側（応答の text が falsy）
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "use_mcp_server", text: JSON.stringify({ server: "s" }), ts: 1000 },
				{ type: "say", say: "mcp_server_response", ts: 1001 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(JSON.parse(result[0]!.text || "{}").response).toBe("")
		})

		it("text が空の use_mcp_server でも応答があれば {} を土台に統合する", () => {
			// msg.text が falsy → `msg.text || "{}"` の "{}" 側
			const messages: ClineMessage[] = [
				{ type: "ask", ask: "use_mcp_server", text: "", ts: 1000 },
				{ type: "say", say: "mcp_server_response", text: "r", ts: 1001 },
			]

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(JSON.parse(result[0]!.text || "{}").response).toBe("r")
		})

		it("text 無しの command と走査中の穴を跨いで出力を統合する", () => {
			// msg.text 無し → `msg.text || ""` の "" 側。index1 の穴 → !currentMsg の j++。
			const messages: ClineMessage[] = []
			messages[0] = { type: "ask", ask: "command", ts: 1000 }
			messages[2] = { type: "ask", ask: "command_output", text: "out", ts: 1002 }
			messages.length = 3

			const result = consolidateCommands(messages)

			expect(result.length).toBe(1)
			expect(result[0]!.text).toBe(`\n${COMMAND_OUTPUT_STRING}out`)
		})

		it("先行 command の無い単独の command_output は最終段で除去される", () => {
			// processedIndices に載らず、最終ループの command_output フィルタで落ちる
			const messages: ClineMessage[] = [{ type: "say", say: "command_output", text: "orphan", ts: 1000 }]

			const result = consolidateCommands(messages)

			expect(result).toEqual([])
		})
	})
})
