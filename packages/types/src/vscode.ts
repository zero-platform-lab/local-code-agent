import { z } from "zod"

/**
 * CodeAction
 */

export const codeActionIds = ["explainCode", "fixCode", "improveCode", "addToContext", "newTask"] as const

export type CodeActionId = (typeof codeActionIds)[number]

export type CodeActionName = "EXPLAIN" | "FIX" | "IMPROVE" | "ADD_TO_CONTEXT" | "NEW_TASK"

/**
 * TerminalAction
 */

export const terminalActionIds = ["terminalAddToContext", "terminalFixCommand", "terminalExplainCommand"] as const

export type TerminalActionId = (typeof terminalActionIds)[number]

export type TerminalActionName = "ADD_TO_CONTEXT" | "FIX" | "EXPLAIN"

export type TerminalActionPromptType = `TERMINAL_${TerminalActionName}`

/**
 * PiiAction
 *
 * 機密情報を伏せ字へ置き換える操作（`FR-PII-11`）。編集中のファイルを対象にするので、
 * webview の provider を必要としない。`commandIds` とは別に持つ。
 */

export const piiActionIds = [
	"maskSecretsInFile",
	"restoreSecretsInFile",
	"addToDictionary",
	"exportDictionary",
	"enableFileVault",
	"disableFileVault",
	"fileVaultStatus",
	"clearSelectedFileVault",
	"clearAllFileVault",
] as const

export type PiiActionId = (typeof piiActionIds)[number]

/**
 * Command
 */

export const commandIds = [
	"activationCompleted",

	"plusButtonClicked",
	"historyButtonClicked",
	"popoutButtonClicked",
	"settingsButtonClicked",

	"openInNewTab",

	"newTask",

	"setCustomStoragePath",
	"importSettings",

	"focusInput",
	"acceptInput",
	"focusPanel",
	"toggleAutoApprove",
	"cycleAutonomyMode",
	"setAutonomyModeManual",
	"setAutonomyModeAutoEdit",
	"setAutonomyModeAuto",
	"setAutonomyModePlan",
] as const

export type CommandId = (typeof commandIds)[number]

/**
 * Language
 */

export const languages = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
] as const

export const languagesSchema = z.enum(languages)

export type Language = z.infer<typeof languagesSchema>

export const isLanguage = (value: string): value is Language => languages.includes(value as Language)
