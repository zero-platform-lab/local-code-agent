import * as vscode from "vscode"
import * as path from "path"

/**
 * 値がパスの 1 セグメントとして安全か（ディレクトリを跨がないか）。
 *
 * `path.join(base, value)` や `path.join(base, \`prefix-${value}\`)` の形で
 * 外部由来の識別子を埋め込む箇所で使う。セパレータを含む値は正規化で親へ抜けるため、
 * 接頭辞を付けていても防げない（`rules-../../..` は 3 階層上を指す）。
 *
 * 抜けた先に `fs.rm(recursive, force)` が飛ぶと何も言わずに消えるので、
 * スキーマ検証が別にある場合でもパスを組む側で必ず止める。
 */
/**
 * `child` が `parent` の中（または parent 自身）に収まっているか。
 *
 * `path.resolve` の結果を突き合わせるので `..` は解決済み。symlink は追わないので、
 * リンクを辿る経路では別途 realpath を取ってから渡すこと。
 */
export function isPathInside(parent: string, child: string): boolean {
	const resolvedParent = path.resolve(parent)
	const resolvedChild = path.resolve(child)
	if (resolvedChild === resolvedParent) return true
	return resolvedChild.startsWith(resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep)
}

export function isSafePathSegment(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false
	if (value === "." || value === "..") return false
	// セパレータは OS 差があるので両方見る。NUL はパス API が受け付けない。
	return !/[/\\\0]/.test(value)
}

/**
 * Checks if a file path is outside all workspace folders
 * @param filePath The file path to check
 * @returns true if the path is outside all workspace folders, false otherwise
 */
export function isPathOutsideWorkspace(filePath: string): boolean {
	// If there are no workspace folders, consider everything outside workspace for safety
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return true
	}

	// Normalize and resolve the path to handle .. and . components correctly
	const absolutePath = path.resolve(filePath)

	// Check if the path is within any workspace folder
	return !vscode.workspace.workspaceFolders.some((folder) => {
		const folderPath = folder.uri.fsPath
		// Path is inside a workspace if it equals the workspace path or is a subfolder
		return absolutePath === folderPath || absolutePath.startsWith(folderPath + path.sep)
	})
}
