import { z } from "zod"

import { nerEntities, piiKinds } from "./pii.js"
import { type Keys } from "./type-fu.js"
import { autonomyModeSchema } from "./autonomy.js"
import {
	type ProviderSettings,
	PROVIDER_SETTINGS_KEYS,
	openAiProxyModeSchema,
	providerSettingsEntrySchema,
	providerSettingsSchema,
} from "./provider-settings.js"
import { historyItemSchema } from "./history.js"
import { codebaseIndexModelsSchema, codebaseIndexConfigSchema } from "./codebase-index.js"
import { experimentsSchema } from "./experiment.js"
import { customModePromptsSchema, customSupportPromptsSchema } from "./mode.js"
import { toolNamesSchema } from "./tool.js"
import { languagesSchema } from "./vscode.js"

/**
 * Default delay in milliseconds after writes to allow diagnostics to detect potential problems.
 * This delay is particularly important for Go and other languages where tools like goimports
 * need time to automatically clean up unused imports.
 */
export const DEFAULT_WRITE_DELAY_MS = 1000

/**
 * コンテキストに含める設定の既定値。
 *
 * これらは**拡張ホスト側（buildState）と webview 側の両方**で必要になる:
 * 拡張は永続値が無いときの埋め合わせに、webview は state 到着前の表示と保存時の
 * フォールバックに使う。両側で数値リテラルを書くと片方だけ変わって静かにずれるため、
 * 唯一の出所をここに置く（`DEFAULT_WRITE_DELAY_MS` と同じ扱い）。
 */

/** コンテキストに載せる「開いているタブ」の既定上限。 */
export const DEFAULT_MAX_OPEN_TABS_CONTEXT = 20

/** コンテキストに載せるワークスペースファイルの既定上限。 */
export const DEFAULT_MAX_WORKSPACE_FILES = 200

/** コンテキストに載せる git status エントリの既定上限（0 = 載せない）。 */
export const DEFAULT_MAX_GIT_STATUS_FILES = 0

/** コンテキストに載せる診断メッセージの既定上限。 */
export const DEFAULT_MAX_DIAGNOSTIC_MESSAGES = 50

/** 画像 1 枚あたりの既定上限（MB）。 */
export const DEFAULT_MAX_IMAGE_FILE_SIZE_MB = 5

/** 1 リクエストの画像合計の既定上限（MB）。 */
export const DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB = 20

/**
 * `.agentignore` されたファイルを一覧に出すか（出す場合は鍵アイコン付き）。
 *
 * 既定は「出さない」。実際に絞り込みを行う `prepareUserContentForRequest` と
 * `fileEditorMessageHandlers` も既定 false で揃っている。
 */
export const DEFAULT_SHOW_AGENT_IGNORED_FILES = false

/** チェックポイント（作業ツリーのスナップショット）を既定で有効にするか。 */
export const DEFAULT_ENABLE_CHECKPOINTS = true

/**
 * 自動要約を始めるコンテキスト使用率の既定（%）。
 *
 * 100 は「上限に達するまで要約しない」を意味する既定値で、0 や 1 のような自明な値ではない
 * ため、拡張ホストと webview の双方で同じ数値を書かないようここに置く。
 */
export const DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT = 100

/**
 * シェル統合が使えるようになるまで待つ既定時間（ミリ秒）。
 *
 * 実際にこの値を適用するのは `BaseTerminal.setShellIntegrationTimeout` だが、
 * 設定画面（webview）も同じ既定を表示する必要がある。webview からは
 * `src/integrations/**` を import できない（alias は `src/shared` までしか通っていないし、
 * 通してもターミナル実装が webview バンドルに入ってしまう）ため、**共有できる唯一の場所が
 * ここ**。`BaseTerminal.defaultShellIntegrationTimeout` はこの定数を参照する。
 */
export const DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS = 5_000

/**
 * Terminal output preview size options for persisted command output.
 *
 * Controls how much command output is kept in memory as a "preview" before
 * the LLM decides to retrieve more via `read_command_output`. Larger previews
 * mean more immediate context but consume more of the context window.
 *
 * - `small`: 5KB preview - Best for long-running commands with verbose output
 * - `medium`: 10KB preview - Balanced default for most use cases
 * - `large`: 20KB preview - Best when commands produce critical info early
 *
 * @see OutputInterceptor - Uses this setting to determine when to spill to disk
 * @see PersistedCommandOutput - Contains the resulting preview and artifact reference
 */
export type TerminalOutputPreviewSize = "small" | "medium" | "large"

/**
 * Byte limits for each terminal output preview size.
 *
 * Maps preview size names to their corresponding byte thresholds.
 * When command output exceeds these thresholds, the excess is persisted
 * to disk and made available via the `read_command_output` tool.
 */
export const TERMINAL_PREVIEW_BYTES: Record<TerminalOutputPreviewSize, number> = {
	small: 5 * 1024, // 5KB
	medium: 10 * 1024, // 10KB
	large: 20 * 1024, // 20KB
}

/**
 * Default terminal output preview size.
 * The "medium" (10KB) setting provides a good balance between immediate
 * visibility and context window conservation for most use cases.
 */
export const DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE: TerminalOutputPreviewSize = "medium"

/**
 * Minimum checkpoint timeout in seconds.
 */
export const MIN_CHECKPOINT_TIMEOUT_SECONDS = 10

/**
 * Maximum checkpoint timeout in seconds.
 */
export const MAX_CHECKPOINT_TIMEOUT_SECONDS = 60

/**
 * Default checkpoint timeout in seconds.
 */
export const DEFAULT_CHECKPOINT_TIMEOUT_SECONDS = 15

/**
 * GlobalSettings
 */

/**
 * スキルの取得元（`FR-EXT-05c`）。
 *
 * 置き場所は URL から機械的に決まるので、利用者が名前を付ける項目は持たない
 * （`FR-EXT-05c1`）。proxy は取得元ごとに指定でき、選択肢は接続先のプロファイルと
 * 同じ 3 種類である（`FR-EXT-05b` `FR-NET-12e`）。
 *
 * **資格情報はここに持たない。** git の保管庫へ預ける（`FR-EXT-06a`）。
 */
/**
 * 機密情報の伏せ字（`FR-PII-01`）。
 *
 * **既定では置き換えない**（`FR-PII-01a`）。置き換えはモデルが読む内容を変えるので、
 * 気づかないうちに挙動が変わる状態を避ける。
 */
export const piiMaskingSchema = z.object({
	/** シークレットモード。送信の直前に置き換えるかどうか（`FR-PII-01b`）。 */
	enabled: z.boolean().optional(),
	/**
	 * 応答の伏せ字を元の値へ戻すか（`FR-PII-19`）。既定は戻す。
	 *
	 * 戻さないと、モデルが書いた `{{person-001}}` がそのままファイルへ残る。文書を
	 * 清書させるときに使う。
	 */
	restore: z.boolean().optional(),
	/** 伏せる種類。省略すると全部を伏せる（`FR-PII-07`）。 */
	kinds: z.array(z.enum(piiKinds)).optional(),
	/** 利用者が挙げた語（`FR-PII-03`）。 */
	terms: z
		.array(
			z.object({
				value: z.string(),
				kind: z.enum(["person", "org", "term"]).optional(),
				/**
				 * 真なら `value` を正規表現として扱う（`FR-PII-03f`）。
				 *
				 * **書き漏らさない。** zod は知らない欄を捨てるので、書き忘れると設定に書いた
				 * 正規表現が普通の語として照合され、黙って 1 件も一致しなくなる。
				 */
				regex: z.boolean().optional(),
			}),
		)
		.optional(),
	/** 辞書のファイル（`FR-PII-03b`）。チームで 1 つの辞書を共有できる。 */
	dictionaryPaths: z.array(z.string()).optional(),
	/** 鍵のラベルに足す語（`FR-PII-10g`）。社内で使う語まで先に並べておくことはできない。 */
	secretLabels: z.array(z.string()).optional(),
	/**
	 * 固有名詞の検出（第 2 層）（`FR-PII-21`〜`FR-PII-23e`）。
	 *
	 * 辞書に無い氏名や社名を、前後の文から判定して伏せる。モデルのファイルを別に置く
	 * 必要があるため、第 1 層とは別の切り替えを持つ。
	 */
	properNouns: z
		.object({
			/** 第 2 層を実行するか（`FR-PII-21c`）。既定は切。 */
			enabled: z.boolean().optional(),
			/** モデルの置き場所（`FR-PII-23a`）。省略すると既定の場所を見る。 */
			modelPath: z.string().optional(),
			/**
			 * 取得先（`FR-PII-23h`）。**既定は持たない。**
			 *
			 * 書かなければ取得のボタンは何もせず、理由を出す。直書きの取得先を持つと、
			 * 拡張が誰の指示も無く特定の場所へ 282 MB を取りに行くことになる。閉鎖環境で
			 * 使うものが、既定で外へ出てよい理由は無い。
			 */
			modelUrl: z.string().optional(),
			/**
			 * 確度の下限（`FR-PII-21d`）。省略すると 0.9。
			 *
			 * **下げると誤検出が入る。** 誤検出はモデルが読む内容を変えるので、取りこぼし
			 * より害が大きい。
			 */
			minScore: z.number().min(0).max(1).optional(),
			/** 伏せる区分（`FR-PII-21a`）。省略すると製品名とイベント名だけを外す。 */
			entities: z.array(z.enum(nerEntities)).optional(),
			/**
			 * 判定にかけてよい時間（ミリ秒）（`FR-PII-23f`）。省略すると 10000。
			 *
			 * **0 なら待ち続ける。** 長い履歴を全部判定させたい人は、時間で切られると
			 * いつまでも取りこぼしが残る。切られたことは警告で出るが、出たところで
			 * 利用者にできることが無かった。
			 */
			timeBudgetMs: z.number().min(0).optional(),
			/**
			 * 時間切れや一時的な失敗のあとに試し直す回数（`FR-PII-23i`）。省略すると 3。
			 *
			 * **0 なら試し直さない。** 一度の不調でその要求ぶんが第 1 層だけになるが、
			 * 待ち時間は短くなる。ファイルの欠けのように繰り返しても直らない失敗は、
			 * この回数に関係なく 1 度で諦める。
			 */
			retryCount: z.number().min(0).optional(),
		})
		.optional(),
})

export type PiiMasking = z.infer<typeof piiMaskingSchema>

export const skillSourceSchema = z.object({
	url: z.string(),
	proxyMode: openAiProxyModeSchema.optional(),
	proxyUrl: z.string().optional(),
	/** ほかの AI コーディングツールと共有する場所へ複製する（`FR-EXT-05f`）。 */
	copyToShared: z.boolean().optional(),
})

export type SkillSource = z.infer<typeof skillSourceSchema>

export const globalSettingsSchema = z.object({
	currentApiConfigName: z.string().optional(),
	listApiConfigMeta: z.array(providerSettingsEntrySchema).optional(),
	pinnedApiConfigs: z.record(z.string(), z.boolean()).optional(),

	customInstructions: z.string().optional(),
	taskHistory: z.array(historyItemSchema).optional(),
	dismissedUpsells: z.array(z.string()).optional(),

	customCondensingPrompt: z.string().optional(),

	autonomyMode: autonomyModeSchema.optional(),
	autoApprovalEnabled: z.boolean().optional(),
	alwaysAllowReadOnly: z.boolean().optional(),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWrite: z.boolean().optional(),
	alwaysAllowWriteOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWriteProtected: z.boolean().optional(),
	writeDelayMs: z.number().min(0).optional(),
	requestDelaySeconds: z.number().optional(),
	alwaysAllowMcp: z.boolean().optional(),
	alwaysAllowSubtasks: z.boolean().optional(),
	alwaysAllowExecute: z.boolean().optional(),
	alwaysAllowFollowupQuestions: z.boolean().optional(),
	followupAutoApproveTimeoutMs: z.number().optional(),
	allowedCommands: z.array(z.string()).optional(),
	deniedCommands: z.array(z.string()).optional(),
	commandExecutionTimeout: z.number().optional(),
	commandTimeoutAllowlist: z.array(z.string()).optional(),
	preventCompletionWithOpenTodos: z.boolean().optional(),
	allowedMaxRequests: z.number().nullish(),
	allowedMaxCost: z.number().nullish(),
	autoCondenseContext: z.boolean().optional(),
	autoCondenseContextPercent: z.number().optional(),

	/**
	 * Whether to include current time in the environment details
	 * @default true
	 */
	includeCurrentTime: z.boolean().optional(),
	/**
	 * Whether to include current cost in the environment details
	 * @default true
	 */
	includeCurrentCost: z.boolean().optional(),
	/**
	 * Maximum number of git status file entries to include in the environment details.
	 * Set to 0 to disable git status. The header (branch, commits) is always included when > 0.
	 * @default 0
	 */
	maxGitStatusFiles: z.number().optional(),

	/**
	 * Whether to include diagnostic messages (errors, warnings) in tool outputs
	 * @default true
	 */
	includeDiagnosticMessages: z.boolean().optional(),
	/**
	 * Maximum number of diagnostic messages to include in tool outputs
	 * @default 50
	 */
	maxDiagnosticMessages: z.number().optional(),

	enableCheckpoints: z.boolean().optional(),
	checkpointTimeout: z
		.number()
		.int()
		.min(MIN_CHECKPOINT_TIMEOUT_SECONDS)
		.max(MAX_CHECKPOINT_TIMEOUT_SECONDS)
		.optional(),

	maxOpenTabsContext: z.number().optional(),
	maxWorkspaceFiles: z.number().optional(),
	showAgentIgnoredFiles: z.boolean().optional(),
	enableSubfolderRules: z.boolean().optional(),
	maxImageFileSize: z.number().optional(),
	maxTotalImageSize: z.number().optional(),

	terminalOutputPreviewSize: z.enum(["small", "medium", "large"]).optional(),
	terminalShellIntegrationTimeout: z.number().optional(),
	terminalShellIntegrationDisabled: z.boolean().optional(),
	terminalCommandDelay: z.number().optional(),
	terminalZdotdir: z.boolean().optional(),
	execaShellPath: z.string().optional(),

	diagnosticsEnabled: z.boolean().optional(),

	rateLimitSeconds: z.number().optional(),
	experiments: experimentsSchema.optional(),

	codebaseIndexModels: codebaseIndexModelsSchema.optional(),
	codebaseIndexConfig: codebaseIndexConfigSchema.optional(),

	language: languagesSchema.optional(),

	mcpEnabled: z.boolean().optional(),

	mode: z.string().optional(),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	customModePrompts: customModePromptsSchema.optional(),
	customSupportPrompts: customSupportPromptsSchema.optional(),
	enhancementApiConfigId: z.string().optional(),
	includeTaskHistoryInEnhance: z.boolean().optional(),
	historyPreviewCollapsed: z.boolean().optional(),
	reasoningBlockCollapsed: z.boolean().optional(),
	/**
	 * Controls the keyboard behavior for sending messages in the chat input.
	 * - "send": Enter sends message, Shift+Enter creates newline (default)
	 * - "newline": Enter creates newline, Shift+Enter/Ctrl+Enter sends message
	 * @default "send"
	 */
	enterBehavior: z.enum(["send", "newline"]).optional(),
	profileThresholds: z.record(z.string(), z.number()).optional(),
	hasOpenedModeSelector: z.boolean().optional(),
	lastSettingsExportPath: z.string().optional(),
	lastTaskExportPath: z.string().optional(),
	lastImageSavePath: z.string().optional(),

	/**
	 * Path to worktree to auto-open after switching workspaces.
	 * Used by the worktree feature to open the Agent sidebar in a new window.
	 */
	worktreeAutoOpenPath: z.string().optional(),
	/**
	 * Whether to show the worktree selector in the home screen.
	 * @default true
	 */
	showWorktreesInHomeScreen: z.boolean().optional(),

	/**
	 * List of native tool names to globally disable.
	 * Tools in this list will be excluded from prompt generation and rejected at execution time.
	 */
	disabledTools: z.array(toolNamesSchema).optional(),
	skillSources: z.array(skillSourceSchema).optional(),
	piiMasking: piiMaskingSchema.optional(),
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export const GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options

/**
 * AgentSettings
 */

export const agentSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)

export type AgentSettings = GlobalSettings & ProviderSettings

/**
 * SecretState
 */
export const SECRET_STATE_KEYS = [
	"openAiApiKey",
	"codeIndexQdrantApiKey",
	"codebaseIndexOpenAiCompatibleApiKey",
] as const

// Global secrets that are part of GlobalSettings (not ProviderSettings)
export const GLOBAL_SECRET_KEYS = [] as const

// Type for the actual secret storage keys
type ProviderSecretKey = (typeof SECRET_STATE_KEYS)[number]
type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number]

// Type representing all secrets that can be stored
export type SecretState = Pick<ProviderSettings, Extract<ProviderSecretKey, keyof ProviderSettings>> & {
	[K in GlobalSecretKey]?: string
}

export const isSecretStateKey = (key: string): key is Keys<SecretState> =>
	SECRET_STATE_KEYS.includes(key as ProviderSecretKey) || GLOBAL_SECRET_KEYS.includes(key as GlobalSecretKey)

/**
 * GlobalState
 */

export type GlobalState = Omit<AgentSettings, Keys<SecretState>>

export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key: Keys<AgentSettings>) => !isSecretStateKey(key),
) as Keys<GlobalState>[]

export const isGlobalStateKey = (key: string): key is Keys<GlobalState> =>
	GLOBAL_STATE_KEYS.includes(key as Keys<GlobalState>)
