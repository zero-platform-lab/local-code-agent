import * as vscode from "vscode"
import { z } from "zod"

// Base configuration schema for common settings
const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(60),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(), // paths to watch for changes and restart server
	disabledTools: z.array(z.string()).default([]),
})

// Custom error messages for better user feedback
export const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"
export const stdioFieldsErrorMessage =
	"For 'stdio' type servers, you must provide a 'command' field and can optionally include 'args' and 'env'"
export const sseFieldsErrorMessage =
	"For 'sse' type servers, you must provide a 'url' field and can optionally include 'headers'"
export const streamableHttpFieldsErrorMessage =
	"For 'streamable-http' type servers, you must provide a 'url' field and can optionally include 'headers'"
export const mixedFieldsErrorMessage =
	"Cannot mix 'stdio' and ('sse' or 'streamable-http') fields. For 'stdio' use 'command', 'args', and 'env'. For 'sse'/'streamable-http' use 'url' and 'headers'"
export const missingFieldsErrorMessage =
	"Server configuration must include either 'command' (for stdio) or 'url' (for sse/streamable-http) and a corresponding 'type' if 'url' is used."
export const urlWithoutTypeErrorMessage =
	"Configuration with 'url' must explicitly specify 'type' as 'sse' or 'streamable-http'."

// Helper function to create a refined schema with better error messages
const createServerTypeSchema = () => {
	return z.union([
		// Stdio config (has command field)
		BaseConfigSchema.extend({
			type: z.enum(["stdio"]).optional(),
			command: z.string().min(1, "Command cannot be empty"),
			args: z.array(z.string()).optional(),
			cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
			env: z.record(z.string()).optional(),
			// Ensure no SSE fields are present
			url: z.undefined().optional(),
			headers: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "stdio" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
		// SSE config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["sse"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "sse" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
		// StreamableHTTP config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["streamable-http"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "streamable-http" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "streamable-http", {
				message: typeErrorMessage,
			}),
	])
}

// Server configuration schema with automatic type inference and validation
export const ServerConfigSchema = createServerTypeSchema()

export type ServerConfig = z.infer<typeof ServerConfigSchema>

// Settings schema
export const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})

/** zod のエラー配列を利用者に見せる 1 本の文字列にする。 */
const formatZodIssues = (error: z.ZodError, separator: string): string =>
	error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join(separator)

/**
 * Validates and normalizes server configuration
 *
 * schema だけでは「どこが悪いのか」が伝わらない（union の全枝が失敗した理由が並ぶ）ため、
 * schema にかける前に stdio 系 / url 系のフィールド組み合わせを先に判定して、
 * 利用者向けの 1 文のエラーにしている。
 *
 * @param config The server configuration to validate
 * @param serverName Optional server name for error messages
 * @returns The validated configuration
 * @throws Error if the configuration is invalid
 */
export function validateServerConfig(config: any, serverName?: string): ServerConfig {
	// Detect configuration issues before validation
	const hasStdioFields = config.command !== undefined
	const hasUrlFields = config.url !== undefined // Covers sse and streamable-http

	// Check for mixed fields (stdio vs url-based)
	if (hasStdioFields && hasUrlFields) {
		throw new Error(mixedFieldsErrorMessage)
	}

	// Infer type for stdio if not provided
	if (!config.type && hasStdioFields) {
		config.type = "stdio"
	}

	// For url-based configs, type must be provided by the user
	if (hasUrlFields && !config.type) {
		throw new Error(urlWithoutTypeErrorMessage)
	}

	// Validate type if provided
	if (config.type && !["stdio", "sse", "streamable-http"].includes(config.type)) {
		throw new Error(typeErrorMessage)
	}

	// Check for type/field mismatch
	if (config.type === "stdio" && !hasStdioFields) {
		throw new Error(stdioFieldsErrorMessage)
	}
	if (config.type === "sse" && !hasUrlFields) {
		throw new Error(sseFieldsErrorMessage)
	}
	if (config.type === "streamable-http" && !hasUrlFields) {
		throw new Error(streamableHttpFieldsErrorMessage)
	}

	// If neither command nor url is present (type alone is not enough)
	if (!hasStdioFields && !hasUrlFields) {
		throw new Error(missingFieldsErrorMessage)
	}

	// Validate the config against the schema
	try {
		return ServerConfigSchema.parse(config)
	} catch (validationError) {
		if (validationError instanceof z.ZodError) {
			// Extract and format validation errors
			const errorMessages = formatZodIssues(validationError, "; ")
			throw new Error(
				serverName
					? `Invalid configuration for server "${serverName}": ${errorMessages}`
					: `Invalid server configuration: ${errorMessages}`,
			)
		}
		throw validationError
	}
}

export type ParsedMcpSettings =
	| { ok: true; servers: Record<string, ServerConfig> }
	| { ok: false; errorMessages: string }

/**
 * 設定ファイル全体（`{ mcpServers: {...} }`）を検証する。
 *
 * 呼び出し元 3 箇所（起動時読み込み / 変更検知 / プロジェクト設定更新）が
 * 同じ「safeParse して zod エラーを改行連結する」処理を重複させていたのを 1 本にしたもの。
 * 失敗時にどう振る舞うか（警告のみ / raw config で続行）は呼び出し側の判断なので、
 * ここでは throw せず結果を返す。
 */
export function parseMcpSettings(raw: unknown): ParsedMcpSettings {
	const result = McpSettingsSchema.safeParse(raw)

	if (result.success) {
		/* v8 ignore next -- 到達不能: McpSettingsSchema は mcpServers を required な z.record として持つため safeParse 成功時は常にオブジェクト（空でも {}）。|| {} の右側は踏めない防御既定として残す。 */
		return { ok: true, servers: result.data.mcpServers || {} }
	}

	return { ok: false, errorMessages: formatZodIssues(result.error, "\n") }
}
