import type { ClineMessage } from "@openai-agent/types"

import { batchConsecutive } from "@src/utils/batchConsecutive"

/**
 * 連続する同種の承認要求を 1 行にまとめる規則。
 *
 * 分割前は `ChatView` の 148 行の `useMemo` の中に、read_file / list_files / file-edit の
 * 3 組が**ほぼ同じ形で 3 回**書かれていた（判定関数と合成関数が対になって 3 セット）。
 * 違うのは「対象の tool 名」「まとめ済みを示すキー」「1 件をどう要約するか」の 3 点だけ
 * なので、その 3 点を表にして規則そのものは 1 本にまとめている。
 *
 * React にも DOM にも依存しない。
 */

/** JSON 文字列で運ばれる tool 情報。形は tool ごとに違うので緩く扱う。 */
type ToolPayload = Record<string, any>

interface BatchSpec {
	/** まとめる対象の tool 名。 */
	readonly tools: readonly string[]
	/**
	 * まとめ済みであることを示すキー。既にこれが入っているメッセージは再度まとめない
	 * （合成結果を次の pass が拾って二重にまとめるのを防ぐ）。
	 */
	readonly batchKey: "batchFiles" | "batchDirs" | "batchDiffs"
	/** 1 件の tool 情報を、まとめ行に出す要約へ変換する。 */
	toEntry(tool: ToolPayload): unknown
	/** tool 情報が壊れていたときの要約。 */
	readonly fallbackEntry: unknown
}

const READ_FILE_BATCH: BatchSpec = {
	tools: ["readFile"],
	batchKey: "batchFiles",
	toEntry: (tool) => ({
		path: tool.path || "",
		lineSnippet: tool.reason || "",
		isOutsideWorkspace: tool.isOutsideWorkspace || false,
		key: `${tool.path}${tool.reason ? ` (${tool.reason})` : ""}`,
		content: tool.content || "",
	}),
	fallbackEntry: { path: "", lineSnippet: "", key: "", content: "" },
}

const LIST_FILES_BATCH: BatchSpec = {
	tools: ["listFilesTopLevel", "listFilesRecursive"],
	batchKey: "batchDirs",
	toEntry: (tool) => ({
		path: tool.path || "",
		// 再帰かどうかは行ごとに違い得るので、まとめ先ではなく各件から取る。
		recursive: tool.tool === "listFilesRecursive",
		isOutsideWorkspace: tool.isOutsideWorkspace || false,
		key: tool.path || "",
	}),
	fallbackEntry: { path: "", recursive: false, key: "" },
}

const EDIT_FILE_BATCH: BatchSpec = {
	tools: ["editedExistingFile", "appliedDiff", "newFileCreated", "insertContent", "searchAndReplace"],
	batchKey: "batchDiffs",
	toEntry: (tool) => ({
		path: tool.path || "",
		changeCount: 1,
		key: tool.path || "",
		content: tool.content || tool.diff || "",
		diffStats: tool.diffStats,
	}),
	fallbackEntry: { path: "", changeCount: 0, key: "", content: "" },
}

/** まとめる順序。file-edit を最後にしているのは分割前と同じ。 */
const BATCH_SPECS: readonly BatchSpec[] = [READ_FILE_BATCH, LIST_FILES_BATCH, EDIT_FILE_BATCH]

function parseTool(message: ClineMessage): ToolPayload | undefined {
	try {
		return JSON.parse(message.text || "{}") as ToolPayload
	} catch {
		return undefined
	}
}

/** この spec でまとめるべき ask か。壊れた JSON と「まとめ済み」は対象外。 */
function matches(spec: BatchSpec, message: ClineMessage): boolean {
	if (message.type !== "ask" || message.ask !== "tool") {
		return false
	}

	const tool = parseTool(message)

	return !!tool && spec.tools.includes(tool.tool) && !tool[spec.batchKey]
}

/**
 * 連続した ask 群を 1 件に合成する。先頭メッセージを土台にして、まとめキーに
 * 各件の要約を並べる。先頭の tool 情報が壊れていたら合成せず先頭をそのまま使う。
 */
function synthesize(spec: BatchSpec, batch: ClineMessage[]): ClineMessage {
	const entries = batch.map((message) => {
		const tool = parseTool(message)

		/* v8 ignore next 3 -- 到達不能: matches() を通った要素だけが batch に入るため */
		if (!tool) {
			return spec.fallbackEntry
		}

		return spec.toEntry(tool)
	})

	const firstTool = parseTool(batch[0])

	/* v8 ignore next 3 -- 到達不能: matches() が parseTool 成功を保証するため */
	if (!firstTool) {
		return batch[0]
	}

	return { ...batch[0], text: JSON.stringify({ ...firstTool, [spec.batchKey]: entries }) }
}

/** 「コンテキスト圧縮中」を示す、メッセージ列には存在しない仮の行。 */
export function condensingPlaceholder(ts: number = Date.now()): ClineMessage {
	return { type: "say", say: "condense_context", ts, partial: true } as ClineMessage
}

export interface GroupMessagesOptions {
	/** コンテキスト圧縮中なら末尾に進行中の行を足す。 */
	isCondensing?: boolean
}

/**
 * 表示対象のメッセージ列を、承認要求のまとまりごとに束ねた列へ変換する。
 */
export function groupChatMessages(messages: ClineMessage[], options: GroupMessagesOptions = {}): ClineMessage[] {
	const grouped = BATCH_SPECS.reduce(
		(current, spec) =>
			batchConsecutive(
				current,
				(message) => matches(spec, message),
				(batch) => synthesize(spec, batch),
			),
		messages,
	)

	return options.isCondensing ? [...grouped, condensingPlaceholder()] : grouped
}
