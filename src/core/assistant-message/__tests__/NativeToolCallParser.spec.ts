import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})
		})
	})

	describe("processStreamingChunk", () => {
		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})
		})

		it("未登録の id には null を返す", () => {
			expect(NativeToolCallParser.finalizeStreamingToolCall("no-such-id")).toBeNull()
		})
	})

	// --- 追加: processStreamingChunk の分岐網羅 ---------------------------------
	describe("processStreamingChunk — 分岐", () => {
		it("未登録の id には null を返す", () => {
			expect(NativeToolCallParser.processStreamingChunk("no-such-id", "{}")).toBeNull()
		})

		it("動的 MCP ツールは部分更新を出さず null（確定を待つ）", () => {
			const id = "s_mcp"
			NativeToolCallParser.startStreamingToolCall(id, "mcp--srv--tool")

			expect(NativeToolCallParser.processStreamingChunk(id, '{"a":1}')).toBeNull()
		})

		it("partial-json parser でも壊れた JSON は握りつぶして null", () => {
			const id = "s_bad"
			NativeToolCallParser.startStreamingToolCall(id, "read_file")

			// "}" 単独は partial-json parser でも例外になるので catch 経路を通る
			expect(NativeToolCallParser.processStreamingChunk(id, "}")).toBeNull()
		})

		it("エイリアス名でストリームすると canonical へ解決し originalName を保持する", () => {
			const id = "s_alias"
			NativeToolCallParser.startStreamingToolCall(id, "write_file") // → write_to_file

			const result = NativeToolCallParser.processStreamingChunk(
				id,
				JSON.stringify({ path: "a.ts", content: "x" }),
			)

			expect(result?.name).toBe("write_to_file")
			expect(result?.originalName).toBe("write_file")
		})

		it("旧 files 形式の部分ストリームは usedLegacyFormat を立てる", () => {
			const id = "s_legacy"
			NativeToolCallParser.startStreamingToolCall(id, "read_file")

			const result = NativeToolCallParser.processStreamingChunk(id, JSON.stringify({ files: [{ path: "a.ts" }] }))

			expect(result?.usedLegacyFormat).toBe(true)
		})

		it("parseJSON が falsy（null）を返しても空オブジェクト扱いで部分 ToolUse を作る", () => {
			const id = "s_null"
			NativeToolCallParser.startStreamingToolCall(id, "read_file")

			// "null" は parseJSON 上は falsy な null になる → `partialArgs || {}` で {} に落ちる
			const result = NativeToolCallParser.processStreamingChunk(id, "null")

			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			expect(result?.params).toEqual({})
		})
	})

	// --- 追加: parseToolCall の異常系とエイリアス ------------------------------
	describe("parseToolCall — 異常系とエイリアス", () => {
		it("未知のツール名は null を返す", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			expect(
				NativeToolCallParser.parseToolCall({ id: "x", name: "bogus_tool" as never, arguments: "{}" }),
			).toBeNull()

			spy.mockRestore()
		})

		it("エイリアス名は canonical へ解決し originalName を保持する", () => {
			const result = NativeToolCallParser.parseToolCall({
				id: "x",
				name: "write_file" as never,
				arguments: JSON.stringify({ path: "a.ts", content: "hi" }),
			})

			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect(result.name).toBe("write_to_file")
				expect(result.originalName).toBe("write_file")
			}
		})

		it("未知のパラメータ名は params から落として警告する", () => {
			const spy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const result = NativeToolCallParser.parseToolCall({
				id: "x",
				name: "read_file",
				arguments: JSON.stringify({ path: "a.ts", not_a_real_param: 1 }),
			})

			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect(result.params.path).toBe("a.ts")
				expect((result.params as Record<string, unknown>).not_a_real_param).toBeUndefined()
			}
			expect(spy).toHaveBeenCalled()

			spy.mockRestore()
		})

		it("nativeArgs を組めない確定ツールは null（内部 throw を握りつぶす）", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			// attempt_completion は result が truthy でないと nativeArgs を組めない
			expect(
				NativeToolCallParser.parseToolCall({
					id: "x",
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "" }),
				}),
			).toBeNull()

			spy.mockRestore()
		})

		it("壊れた JSON arguments は null を返す", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			expect(NativeToolCallParser.parseToolCall({ id: "x", name: "read_file", arguments: "{bad" })).toBeNull()

			spy.mockRestore()
		})

		it("空文字の arguments は空オブジェクトとして扱う", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			// read_file は path/files が無いと組めないので null になるが、"" 分岐を通す
			expect(NativeToolCallParser.parseToolCall({ id: "x", name: "read_file", arguments: "" })).toBeNull()

			spy.mockRestore()
		})

		it("動的 MCP ツール名は McpToolUse へルーティングする", () => {
			const result = NativeToolCallParser.parseToolCall({
				id: "x",
				name: "mcp--weather--forecast" as never,
				arguments: JSON.stringify({ city: "Tokyo" }),
			})

			expect(result?.type).toBe("mcp_tool_use")
			if (result?.type === "mcp_tool_use") {
				expect(result.serverName).toBe("weather")
				expect(result.toolName).toBe("forecast")
				expect(result.arguments).toEqual({ city: "Tokyo" })
			}
		})
	})

	// --- 追加: parseDynamicMcpTool -------------------------------------------
	describe("parseDynamicMcpTool", () => {
		it("mcp--server--tool 名を分解して McpToolUse にする", () => {
			const result = NativeToolCallParser.parseDynamicMcpTool({
				id: "call_1",
				name: "mcp--weather--get_forecast",
				arguments: JSON.stringify({ city: "Tokyo" }),
			})

			expect(result).toMatchObject({
				type: "mcp_tool_use",
				id: "call_1",
				name: "mcp--weather--get_forecast",
				serverName: "weather",
				toolName: "get_forecast",
				arguments: { city: "Tokyo" },
				partial: false,
			})
		})

		it("アンダースコア区切りも正規化して分解し、元の名前は保持する", () => {
			const result = NativeToolCallParser.parseDynamicMcpTool({
				id: "call_2",
				name: "mcp__weather__get_forecast",
				arguments: "{}",
			})

			expect(result?.serverName).toBe("weather")
			expect(result?.toolName).toBe("get_forecast")
			// 元の name は API 履歴のため保持する
			expect(result?.name).toBe("mcp__weather__get_forecast")
		})

		it("arguments が空文字なら空オブジェクトにする", () => {
			const result = NativeToolCallParser.parseDynamicMcpTool({ id: "c", name: "mcp--s--t", arguments: "" })

			expect(result?.arguments).toEqual({})
		})

		it("区切りが足りない名前は null を返す", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			expect(
				NativeToolCallParser.parseDynamicMcpTool({ id: "c", name: "mcp--onlyserver", arguments: "{}" }),
			).toBeNull()

			spy.mockRestore()
		})

		it("壊れた JSON は null を返す", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			expect(
				NativeToolCallParser.parseDynamicMcpTool({ id: "c", name: "mcp--s--t", arguments: "{bad" }),
			).toBeNull()

			spy.mockRestore()
		})
	})

	// --- 追加: hasActiveStreamingToolCalls ------------------------------------
	describe("hasActiveStreamingToolCalls", () => {
		it("開始前は false、開始後は true", () => {
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
			NativeToolCallParser.startStreamingToolCall("h1", "read_file")
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(true)
		})
	})

	// --- 追加: 生チャンク処理（processRawChunk / FinishReason / finalize） ------
	describe("processRawChunk", () => {
		it("id が無く未追跡のチャンクは何も出さない", () => {
			expect(NativeToolCallParser.processRawChunk({ index: 0 })).toEqual([])
		})

		it("id と name が揃えば即 start を出す", () => {
			const events = NativeToolCallParser.processRawChunk({ index: 0, id: "call_a", name: "read_file" })

			expect(events).toEqual([{ type: "tool_call_start", id: "call_a", name: "read_file" }])
		})

		it("name より先に来た引数はバッファし、name 到着時に start の後へ flush する", () => {
			// 1) id だけ（name 未定）→ 追跡開始・イベント無し
			expect(NativeToolCallParser.processRawChunk({ index: 1, id: "call_b" })).toEqual([])
			// 2) name 前の引数 → バッファへ退避
			expect(NativeToolCallParser.processRawChunk({ index: 1, arguments: '{"pa' })).toEqual([])
			// 3) name 到着 → start + バッファ flush、同一チャンクの引数は通常 delta
			const events = NativeToolCallParser.processRawChunk({ index: 1, name: "read_file", arguments: 'th":1}' })

			expect(events).toEqual([
				{ type: "tool_call_start", id: "call_b", name: "read_file" },
				{ type: "tool_call_delta", id: "call_b", delta: '{"pa' },
				{ type: "tool_call_delta", id: "call_b", delta: 'th":1}' },
			])
		})

		it("start 済みなら引数は即 delta として流す", () => {
			NativeToolCallParser.processRawChunk({ index: 2, id: "call_c", name: "read_file" })
			const events = NativeToolCallParser.processRawChunk({ index: 2, arguments: "chunk" })

			expect(events).toEqual([{ type: "tool_call_delta", id: "call_c", delta: "chunk" }])
		})
	})

	describe("processFinishReason", () => {
		it("finish_reason が tool_calls なら追跡中の各呼び出しに end を出す", () => {
			NativeToolCallParser.processRawChunk({ index: 0, id: "call_a", name: "read_file" })
			NativeToolCallParser.processRawChunk({ index: 1, id: "call_b", name: "list_files" })

			const events = NativeToolCallParser.processFinishReason("tool_calls")

			expect(events).toEqual(
				expect.arrayContaining([
					{ type: "tool_call_end", id: "call_a" },
					{ type: "tool_call_end", id: "call_b" },
				]),
			)
			expect(events).toHaveLength(2)
		})

		it("tool_calls 以外の finish_reason では何も出さない", () => {
			NativeToolCallParser.processRawChunk({ index: 0, id: "call_a", name: "read_file" })

			expect(NativeToolCallParser.processFinishReason("stop")).toEqual([])
			expect(NativeToolCallParser.processFinishReason(null)).toEqual([])
			expect(NativeToolCallParser.processFinishReason(undefined)).toEqual([])
		})

		it("追跡が空なら tool_calls でも何も出さない", () => {
			expect(NativeToolCallParser.processFinishReason("tool_calls")).toEqual([])
		})
	})

	describe("finalizeRawChunks", () => {
		it("start 済みの呼び出しに end を出し、状態をクリアする", () => {
			NativeToolCallParser.processRawChunk({ index: 0, id: "call_a", name: "read_file" })

			expect(NativeToolCallParser.finalizeRawChunks()).toEqual([{ type: "tool_call_end", id: "call_a" }])
			// 2 度目は空（クリア済み）
			expect(NativeToolCallParser.finalizeRawChunks()).toEqual([])
		})

		it("start していない呼び出しには end を出さないが状態はクリアする", () => {
			// id だけ来て name 未到着 → hasStarted=false
			NativeToolCallParser.processRawChunk({ index: 0, id: "call_a" })

			expect(NativeToolCallParser.finalizeRawChunks()).toEqual([])
			// クリアされていることを確認
			expect(NativeToolCallParser.finalizeRawChunks()).toEqual([])
		})
	})
})
