import type { FileEntry, ToolName } from "@openai-agent/types"

/**
 * 「native tool call の JSON 引数から、tool ごとの typed `nativeArgs` をどう組むか」の一覧。
 *
 * 分割前は `NativeToolCallParser` の中に **ほぼ同じ内容の switch が 2 本**あった:
 * `createPartialToolUse`（ストリーミング途中・約 235 行）と `parseToolCall`（確定時・約 253 行）。
 * 両者の違いは実質 3 点しかないのに 2 本並んでいたため、tool を 1 つ足すたびに 2 箇所を直す
 * 必要があり、実際に 2 つの tool が片方にしか無い状態になっていた（下記 `finalOnly`）。
 *
 * ここでは違いを宣言として持たせ、組み立て規則そのものは 1 本にまとめている:
 *
 * 1. **必須キーの判定が partial では OR / final では AND**
 *    ストリーミング中は「どれか 1 つ来た時点で」UI を更新したいが、確定時は全部揃っていなければ
 *    不正な tool call として扱う。
 * 2. **partial では組まない tool がある**（`finalOnly`）
 * 3. **partial だけ組み方が違う tool がある**（`buildPartial`）
 *
 * vscode / API に依存しない純データなので、tool ごとの規則を素でテストできる。
 */

export type NativeToolArgsInput = Record<string, any>

/** キーが「ある」と見なす条件。 */
type Presence = "defined" | "truthy"

export interface NativeArgsSpec {
	/**
	 * 確定時に **すべて**揃っている必要があるキー。ストリーミング中は **どれか 1 つ**でよい。
	 * 空配列 = ゲート無し（`build` が undefined を返すかどうかで判断する。read_file 用）。
	 */
	readonly required: readonly string[]
	/** 既定は `!== undefined`。`truthy` は空文字も弾く。 */
	readonly presence?: Presence
	/** ストリーミング中だけ判定を変える tool 用（write_to_file）。 */
	readonly partialPresence?: Presence
	/** ストリーミング中は nativeArgs を組まない。 */
	readonly finalOnly?: true
	/** JSON 引数から nativeArgs を組む。組めなければ undefined。 */
	build(args: NativeToolArgsInput): unknown
	/** ストリーミング中だけ組み方を差し替える（ask_followup_question）。 */
	buildPartial?(args: NativeToolArgsInput): unknown
}

// --- 値の正規化（モデルが型を守らないことがあるため） -------------------------------

export function coerceOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value
	}

	if (typeof value === "string") {
		const lower = value.trim().toLowerCase()

		if (lower === "true") {
			return true
		}

		if (lower === "false") {
			return false
		}
	}

	return undefined
}

export function coerceOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}

	if (typeof value === "string") {
		const n = Number(value)

		if (Number.isFinite(n)) {
			return n
		}
	}

	return undefined
}

/**
 * API から来た生の file entry（`line_ranges`）を `FileEntry`（`lineRanges`）へ。
 * 後方互換のため 3 形式を受ける:
 *
 * - tuple : `{ path, line_ranges: [[1, 50]] }`
 * - object: `{ path, line_ranges: [{ start: 1, end: 50 }] }`
 * - legacy: `{ path, line_ranges: ["1-50"] }`
 */
export function convertFileEntries(files: unknown[]): FileEntry[] {
	return files.map((file: unknown) => {
		const f = file as Record<string, unknown>
		const entry: FileEntry = { path: f.path as string }

		if (f.line_ranges && Array.isArray(f.line_ranges)) {
			entry.lineRanges = (f.line_ranges as unknown[])
				.map((range: unknown) => {
					if (Array.isArray(range) && range.length >= 2) {
						return { start: Number(range[0]), end: Number(range[1]) }
					}

					if (typeof range === "object" && range !== null && "start" in range && "end" in range) {
						const r = range as { start: unknown; end: unknown }
						return { start: Number(r.start), end: Number(r.end) }
					}

					if (typeof range === "string") {
						const match = range.match(/^(\d+)-(\d+)$/)

						if (match) {
							return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) }
						}
					}

					return null
				})
				.filter((r): r is { start: number; end: number } => r !== null)
		}

		return entry
	})
}

// --- read_file だけは形が 2 通りあるので専用ビルダ -----------------------------------

/**
 * `read_file` は「新形式 `{ path, mode, ... }`」と「旧形式 `{ files: [...] }`」の 2 通り。
 * 旧形式が来たら `_legacyFormat: true` を立てる（呼び出し側が `usedLegacyFormat` の判定に使う）。
 * 一部のモデルが `files` を二重に stringify するので、文字列で来た場合も一度パースを試みる。
 */
function buildReadFileArgs(args: NativeToolArgsInput): unknown {
	if (args.files !== undefined) {
		let filesArray: unknown[] | null = null

		if (Array.isArray(args.files)) {
			filesArray = args.files
		} else if (typeof args.files === "string") {
			try {
				const parsed = JSON.parse(args.files)

				if (Array.isArray(parsed)) {
					filesArray = parsed
				}
			} catch {
				// Not valid JSON, ignore
			}
		}

		if (filesArray && filesArray.length > 0) {
			return { files: convertFileEntries(filesArray), _legacyFormat: true as const }
		}
	}

	if (args.path !== undefined) {
		return {
			path: args.path,
			mode: args.mode,
			offset: coerceOptionalNumber(args.offset),
			limit: coerceOptionalNumber(args.limit),
			indentation:
				args.indentation && typeof args.indentation === "object"
					? {
							anchor_line: coerceOptionalNumber(args.indentation.anchor_line),
							max_levels: coerceOptionalNumber(args.indentation.max_levels),
							max_lines: coerceOptionalNumber(args.indentation.max_lines),
							include_siblings: coerceOptionalBoolean(args.indentation.include_siblings),
							include_header: coerceOptionalBoolean(args.indentation.include_header),
						}
					: undefined,
		}
	}

	return undefined
}

// --- tool ごとの規則 ---------------------------------------------------------------

const editLikeArgs = (args: NativeToolArgsInput) => ({
	file_path: args.file_path,
	old_string: args.old_string,
	new_string: args.new_string,
})

export const nativeArgsSpecs: Partial<Record<ToolName, NativeArgsSpec>> = {
	// ゲート無し: 形が 2 通りあるので build 自身が可否を決める。
	read_file: { required: [], build: buildReadFileArgs },

	attempt_completion: {
		required: ["result"],
		presence: "truthy",
		build: (args) => ({ result: args.result }),
	},

	execute_command: {
		required: ["command"],
		presence: "truthy",
		build: (args) => ({ command: args.command, cwd: args.cwd, timeout: args.timeout }),
	},

	// partial だけ truthy 判定（空文字では組まない）という非対称を保持している。
	write_to_file: {
		required: ["path", "content"],
		partialPresence: "truthy",
		build: (args) => ({ path: args.path, content: args.content }),
	},

	ask_followup_question: {
		required: ["question", "follow_up"],
		build: (args) => ({ question: args.question, follow_up: args.follow_up }),
		// ストリーミング中は follow_up が配列になり切っていないことがあるので落とす。
		buildPartial: (args) => ({
			question: args.question,
			follow_up: Array.isArray(args.follow_up) ? args.follow_up : undefined,
		}),
	},

	apply_diff: {
		required: ["path", "diff"],
		build: (args) => ({ path: args.path, diff: args.diff }),
	},

	codebase_search: {
		required: ["query"],
		build: (args) => ({ query: args.query, path: args.path }),
	},

	run_slash_command: {
		required: ["command"],
		build: (args) => ({ command: args.command, args: args.args }),
	},

	skill: {
		required: ["skill"],
		build: (args) => ({ skill: args.skill, args: args.args }),
	},

	search_files: {
		required: ["path", "regex"],
		build: (args) => ({ path: args.path, regex: args.regex, file_pattern: args.file_pattern }),
	},

	switch_mode: {
		required: ["mode_slug", "reason"],
		build: (args) => ({ mode_slug: args.mode_slug, reason: args.reason }),
	},

	update_todo_list: {
		required: ["todos"],
		build: (args) => ({ todos: args.todos }),
	},

	use_mcp_tool: {
		required: ["server_name", "tool_name"],
		build: (args) => ({ server_name: args.server_name, tool_name: args.tool_name, arguments: args.arguments }),
	},

	apply_patch: {
		required: ["patch"],
		build: (args) => ({ patch: args.patch }),
	},

	search_replace: {
		required: ["file_path", "old_string", "new_string"],
		build: editLikeArgs,
	},

	edit: {
		required: ["file_path", "old_string", "new_string"],
		build: (args) => ({ ...editLikeArgs(args), replace_all: coerceOptionalBoolean(args.replace_all) }),
	},

	search_and_replace: {
		required: ["file_path", "old_string", "new_string"],
		build: (args) => ({ ...editLikeArgs(args), replace_all: coerceOptionalBoolean(args.replace_all) }),
	},

	edit_file: {
		required: ["file_path", "old_string", "new_string"],
		build: (args) => ({ ...editLikeArgs(args), expected_replacements: args.expected_replacements }),
	},

	list_files: {
		required: ["path"],
		build: (args) => ({ path: args.path, recursive: coerceOptionalBoolean(args.recursive) }),
	},

	new_task: {
		required: ["mode", "message"],
		build: (args) => ({ mode: args.mode, message: args.message, todos: args.todos }),
	},

	// ↓ 分割前は partial 側の switch に case が無かった 2 つ。ストリーミング中は
	//   nativeArgs が undefined のままになる（handlePartial は params 側を見る）。
	read_command_output: {
		required: ["artifact_id"],
		finalOnly: true,
		build: (args) => ({
			artifact_id: args.artifact_id,
			search: args.search,
			offset: args.offset,
			limit: args.limit,
		}),
	},

	access_mcp_resource: {
		required: ["server_name", "uri"],
		finalOnly: true,
		build: (args) => ({ server_name: args.server_name, uri: args.uri }),
	},
}

/**
 * tool 名と JSON 引数から `nativeArgs` を組む。組めなければ undefined。
 *
 * @param phase `"partial"` = ストリーミング途中（必須キーはどれか 1 つで足りる）、
 *              `"final"` = 確定時（すべて必要）。
 */
export function buildNativeArgs(
	name: ToolName,
	args: NativeToolArgsInput,
	phase: "partial" | "final",
): unknown | undefined {
	const spec = nativeArgsSpecs[name]

	if (!spec || (phase === "partial" && spec.finalOnly)) {
		return undefined
	}

	if (spec.required.length > 0) {
		const presence = (phase === "partial" ? spec.partialPresence : undefined) ?? spec.presence ?? "defined"
		const has = (key: string) => (presence === "truthy" ? Boolean(args[key]) : args[key] !== undefined)

		if (!(phase === "partial" ? spec.required.some(has) : spec.required.every(has))) {
			return undefined
		}
	}

	return phase === "partial" && spec.buildPartial ? spec.buildPartial(args) : spec.build(args)
}
