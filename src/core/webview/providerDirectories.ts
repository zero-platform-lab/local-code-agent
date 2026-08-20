import type { ContextProxy } from "../config/ContextProxy"

/**
 * グローバルストレージ配下の settings ディレクトリのパスを解決する。
 */
export async function ensureSettingsDirectory(contextProxy: ContextProxy): Promise<string> {
	const { getSettingsDirectoryPath } = await import("../../utils/storage")
	const globalStoragePath = contextProxy.globalStorageUri.fsPath
	return getSettingsDirectoryPath(globalStoragePath)
}
