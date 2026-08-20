import * as fs from "fs/promises"

/** MCP 設定ファイルの中身（`mcpServers` 以外のキーは触らずに保つ）。 */
export type McpSettingsFile = {
	mcpServers?: Record<string, any>
	[key: string]: unknown
}

/**
 * 設定ファイルの置き場所を教えてくれる最小表面。
 * global は「無ければ作って返す」、project は「無ければ null」という非対称な契約。
 */
export interface McpSettingsPathResolver {
	getGlobalSettingsPath(): Promise<string>
	getProjectSettingsPath(): Promise<string | null>
}

/**
 * source に対応する設定ファイルの絶対パスを返す。
 *
 * McpHub の 4 メソッド（config 読み / config 更新 / サーバ削除 / ツール一覧更新）が
 * 同じ分岐を複製していたのを 1 本にしたもの。
 *
 * @throws project 設定ファイルが存在しない場合
 */
export async function resolveSettingsPath(
	paths: McpSettingsPathResolver,
	source: "global" | "project",
): Promise<string> {
	if (source !== "project") {
		return paths.getGlobalSettingsPath()
	}

	const projectMcpPath = await paths.getProjectSettingsPath()
	if (!projectMcpPath) {
		throw new Error("Project MCP configuration file not found")
	}

	return projectMcpPath
}

/**
 * 設定ファイルを読んで JSON として返す。
 *
 * @throws ファイルにアクセスできない / JSON がオブジェクトでない場合
 */
export async function readSettingsFile(configPath: string): Promise<McpSettingsFile> {
	// Ensure the settings file exists and is accessible
	try {
		await fs.access(configPath)
	} catch (error) {
		console.error("Settings file not accessible:", error)
		throw new Error("Settings file not accessible")
	}

	const content = await fs.readFile(configPath, "utf-8")
	const config = JSON.parse(content)

	if (!config || typeof config !== "object") {
		throw new Error("Invalid config structure")
	}

	return config as McpSettingsFile
}

/**
 * `mcpServers` セクションを取り出す（読み取り用）。
 * @throws セクションが無い場合
 */
export function requireServersSection(config: McpSettingsFile): Record<string, any> {
	if (!config.mcpServers || typeof config.mcpServers !== "object") {
		throw new Error("No mcpServers section in config")
	}

	return config.mcpServers
}

/**
 * `mcpServers` セクションを取り出す（書き込み用。無ければ空で作って設定に差し込む）。
 */
export function ensureServersSection(config: McpSettingsFile): Record<string, any> {
	if (!config.mcpServers || typeof config.mcpServers !== "object") {
		config.mcpServers = {}
	}

	return config.mcpServers
}

/**
 * source の設定ファイルから `mcpServers` セクションだけを読む。
 *
 * {@link readSettingsFile} と違い存在チェックも構造検証もしない（読めた JSON を信じる）。
 * 「ツール許可設定を読む」「webview 表示順を読む」のように、失敗しても致命的でない
 * 参照用の読み取りに使う。**エラー処理は呼び出し側の方針に任せるため握り潰さない。**
 *
 * @returns `mcpServers`（セクションが無ければ空）。project 設定ファイルが存在しなければ null。
 */
export async function readServerEntries(
	paths: McpSettingsPathResolver,
	source: "global" | "project",
): Promise<Record<string, any> | null> {
	const configPath = source === "project" ? await paths.getProjectSettingsPath() : await paths.getGlobalSettingsPath()

	if (!configPath) {
		return null
	}

	const content = await fs.readFile(configPath, "utf-8")
	const config = JSON.parse(content)

	return config?.mcpServers ?? {}
}

/** 設定ファイルに書かれた順のサーバ名一覧（webview の表示順に使う）。 */
export function serverOrderFrom(entries: Record<string, any> | null): string[] {
	return Object.keys(entries ?? {})
}
