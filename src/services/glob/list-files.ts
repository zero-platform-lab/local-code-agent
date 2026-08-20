import os from "os"
import * as path from "path"
import * as fs from "fs"
import * as childProcess from "child_process"
import * as vscode from "vscode"
import ignore from "ignore"
import { arePathsEqual } from "../../utils/path"
import { getBinPath } from "../../services/ripgrep"
import { DIRS_TO_IGNORE } from "./constants"

/**
 * Context object for directory scanning operations
 */
interface ScanContext {
	/** Whether this is the explicitly targeted directory */
	isTargetDir: boolean
	/** Whether we're inside an explicitly targeted hidden directory */
	insideExplicitHiddenTarget: boolean
	/** The base path for the scan operation */
	basePath: string
	/** The ignore instance for gitignore handling */
	ignoreInstance: ReturnType<typeof ignore>
}

/**
 * List files in a directory, with optional recursive traversal
 *
 * @param dirPath - Directory path to list files from
 * @param recursive - Whether to recursively list files in subdirectories
 * @param limit - Maximum number of files to return
 * @returns Tuple of [file paths array, whether the limit was reached]
 */
export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[string[], boolean]> {
	// Early return for limit of 0 - no need to scan anything
	if (limit === 0) {
		return [[], false]
	}

	// Handle special directories
	const specialResult = await handleSpecialDirectories(dirPath)

	if (specialResult) {
		return specialResult
	}

	// ignore（.gitignore 等）は ripgrep 経路でも fs fallback でも使うので先に作る。
	const ignoreInstance = await createIgnoreInstance(dirPath)

	// ripgrep があればそれで、無ければ fs で走査する（rg 未同梱の環境でも動く）。
	const rgPath = await tryGetRipgrepPath()

	if (!recursive) {
		const files = rgPath
			? await listFilesWithRipgrep(rgPath, dirPath, false, limit)
			: await listFilesWithFs(dirPath, false, limit, ignoreInstance)
		// Calculate remaining limit for directories
		const remainingLimit = Math.max(0, limit - files.length)
		const directories = await listFilteredDirectories(dirPath, false, ignoreInstance, remainingLimit)
		return formatAndCombineResults(files, directories, limit)
	}

	// For recursive mode, use the original approach but ensure first-level directories are included
	const files = rgPath
		? await listFilesWithRipgrep(rgPath, dirPath, true, limit)
		: await listFilesWithFs(dirPath, true, limit, ignoreInstance)
	// Calculate remaining limit for directories
	const remainingLimit = Math.max(0, limit - files.length)
	const directories = await listFilteredDirectories(dirPath, true, ignoreInstance, remainingLimit)

	// Combine and check if we hit the limits
	const [results, limitReached] = formatAndCombineResults(files, directories, limit)

	// If we hit the limit, ensure all first-level directories are included
	if (limitReached) {
		const firstLevelDirs = await getFirstLevelDirectories(dirPath, ignoreInstance)
		return ensureFirstLevelDirectoriesIncluded(results, firstLevelDirs, limit)
	}

	return [results, limitReached]
}

/**
 * Get only the first-level directories in a path
 */
async function getFirstLevelDirectories(dirPath: string, ignoreInstance: ReturnType<typeof ignore>): Promise<string[]> {
	const absolutePath = path.resolve(dirPath)
	const directories: string[] = []

	try {
		const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true })

		for (const entry of entries) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				const fullDirPath = path.join(absolutePath, entry.name)
				const context: ScanContext = {
					isTargetDir: false,
					insideExplicitHiddenTarget: false,
					basePath: dirPath,
					ignoreInstance,
				}
				if (shouldIncludeDirectory(entry.name, fullDirPath, context)) {
					/* v8 ignore next -- 到達不能: fullDirPath は path.join(absolutePath, entry.name) 由来で、path.join は末尾セパレータを常に除去するため endsWith("/") の真側（既に "/" で終わるケース）へは入らない。防御的な正規化として残す。 */
					const formattedPath = fullDirPath.endsWith("/") ? fullDirPath : `${fullDirPath}/`
					directories.push(formattedPath)
				}
			}
		}
	} catch (err) {
		console.warn(`Could not read directory ${absolutePath}: ${err}`)
	}

	return directories
}

/**
 * Ensure all first-level directories are included in the results
 */
function ensureFirstLevelDirectoriesIncluded(
	results: string[],
	firstLevelDirs: string[],
	limit: number,
): [string[], boolean] {
	// Create a set of existing paths for quick lookup
	const existingPaths = new Set(results)

	// Find missing first-level directories
	const missingDirs = firstLevelDirs.filter((dir) => !existingPaths.has(dir))

	if (missingDirs.length === 0) {
		// All first-level directories are already included
		return [results, true]
	}

	// We need to make room for the missing directories
	// Remove items from the end (which are likely deeper in the tree)
	const itemsToRemove = Math.min(missingDirs.length, results.length)
	const adjustedResults = results.slice(0, results.length - itemsToRemove)

	// Add the missing directories at the beginning (after any existing first-level dirs)
	// First, separate existing results into first-level and others
	const resultPaths = adjustedResults.map((r) => path.resolve(r))
	const basePath = path.resolve(firstLevelDirs[0]).split(path.sep).slice(0, -1).join(path.sep)

	const firstLevelResults: string[] = []
	const otherResults: string[] = []

	for (let i = 0; i < adjustedResults.length; i++) {
		const resolvedPath = resultPaths[i]
		const relativePath = path.relative(basePath, resolvedPath)
		const depth = relativePath.split(path.sep).length

		if (depth === 1) {
			firstLevelResults.push(adjustedResults[i])
		} else {
			otherResults.push(adjustedResults[i])
		}
	}

	// Combine: existing first-level dirs + missing first-level dirs + other results
	const finalResults = [...firstLevelResults, ...missingDirs, ...otherResults].slice(0, limit)

	return [finalResults, true]
}

/**
 * Handle special directories (root, home) that should not be fully listed
 */
async function handleSpecialDirectories(dirPath: string): Promise<[string[], boolean] | null> {
	const absolutePath = path.resolve(dirPath)

	// Do not allow listing files in root directory
	const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
	const isRoot = arePathsEqual(absolutePath, root)
	if (isRoot) {
		return [[root], false]
	}

	// Do not allow listing files in home directory
	const homeDir = os.homedir()
	const isHomeDir = arePathsEqual(absolutePath, homeDir)
	if (isHomeDir) {
		return [[homeDir], false]
	}

	return null
}

/**
 * Get the path to the ripgrep binary
 */
async function tryGetRipgrepPath(): Promise<string | undefined> {
	// 見つからなければ undefined。以前は throw していたが、ripgrep が同梱されない VS Code 配布
	// （一部の Windows 環境等）で例外が伝播し、環境情報のファイル一覧が空になっていた。
	// 呼び出し側で fs 走査に fallback するため、ここでは投げずに undefined を返す。
	return getBinPath(vscode.env.appRoot)
}

/**
 * List files using ripgrep with appropriate arguments
 */
async function listFilesWithRipgrep(
	rgPath: string,
	dirPath: string,
	recursive: boolean,
	limit: number,
): Promise<string[]> {
	const rgArgs = buildRipgrepArgs(dirPath, recursive)

	const relativePaths = await execRipgrep(rgPath, rgArgs, limit)

	// Convert relative paths from ripgrep to absolute paths
	// Resolve dirPath once here for the mapping operation
	const absolutePath = path.resolve(dirPath)
	return relativePaths.map((relativePath) => path.resolve(absolutePath, relativePath))
}

/**
 * ripgrep が使えないときの **fs ベースのファイル走査 fallback**。
 *
 * ignore（.gitignore 等）を尊重し、重い/無関係なディレクトリ（node_modules・.git・hidden 等）
 * には降りず、`limit` で打ち切る。symlink は辿らない（循環防止）。戻り値は
 * {@link listFilesWithRipgrep} と揃えて **絶対パス**。ファイルのみ返す（ディレクトリは
 * listFilteredDirectories が別途担う）。
 */
export async function listFilesWithFs(
	dirPath: string,
	recursive: boolean,
	limit: number,
	ignoreInstance: ReturnType<typeof ignore>,
): Promise<string[]> {
	const root = path.resolve(dirPath)
	const results: string[] = []
	const queue: string[] = [root]

	while (queue.length > 0 && results.length < limit) {
		const current = queue.shift() as string
		let entries: fs.Dirent[]
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true })
		} catch {
			// 読めないディレクトリ（権限等）はスキップして続行。
			continue
		}
		for (const entry of entries) {
			if (results.length >= limit) {
				break
			}
			if (entry.isSymbolicLink()) {
				continue
			}
			const full = path.join(current, entry.name)
			// ignore ライブラリは POSIX 相対パスを要求する。
			const relPosix = path.relative(root, full).split(path.sep).join("/")

			if (entry.isDirectory()) {
				if (!recursive) {
					continue
				}
				// node_modules/.git/hidden 等には降りない（ripgrep の既定挙動に合わせる）。
				if (isDirectoryExplicitlyIgnored(entry.name) || entry.name.startsWith(".")) {
					continue
				}
				if (relPosix && ignoreInstance.ignores(`${relPosix}/`)) {
					continue
				}
				queue.push(full)
			} else if (entry.isFile()) {
				if (relPosix && ignoreInstance.ignores(relPosix)) {
					continue
				}
				results.push(full)
			}
		}
	}

	return results
}

/**
 * Build appropriate ripgrep arguments based on whether we're doing a recursive search
 */
function buildRipgrepArgs(dirPath: string, recursive: boolean): string[] {
	// Base arguments to list files
	const args = ["--files", "--hidden", "--follow"]

	if (recursive) {
		return [...args, ...buildRecursiveArgs(dirPath), dirPath]
	} else {
		return [...args, ...buildNonRecursiveArgs(), dirPath]
	}
}

/**
 * Build ripgrep arguments for recursive directory traversal
 */
function buildRecursiveArgs(dirPath: string): string[] {
	const args: string[] = []

	// In recursive mode, respect .gitignore by default
	// (ripgrep does this automatically)

	// Check if we're explicitly targeting a hidden directory
	// Normalize the path first to handle edge cases
	const normalizedPath = path.normalize(dirPath)
	// Split by separator and filter out empty parts
	// This handles cases like trailing slashes, multiple separators, etc.
	const pathParts = normalizedPath.split(path.sep).filter((part) => part.length > 0)
	const isTargetingHiddenDir = pathParts.some((part) => part.startsWith("."))

	// Get the target directory name to check if it's in the ignore list
	const targetDirName = path.basename(dirPath)
	const isTargetInIgnoreList = DIRS_TO_IGNORE.includes(targetDirName)

	// If targeting a hidden directory or a directory in the ignore list,
	// use special handling to ensure all files are shown
	if (isTargetingHiddenDir || isTargetInIgnoreList) {
		args.push("--no-ignore-vcs")
		args.push("--no-ignore")

		// When targeting an ignored directory, we need to be careful with glob patterns
		// Add a pattern to explicitly include files at the root level
		args.push("-g", "*")
		args.push("-g", "**/*")
	}

	// Apply directory exclusions for recursive searches
	for (const dir of DIRS_TO_IGNORE) {
		// Special handling for hidden directories pattern
		if (dir === ".*") {
			// If we're explicitly targeting a hidden directory, don't exclude hidden files/dirs
			// This allows the target hidden directory and all its contents to be listed
			if (!isTargetingHiddenDir) {
				// Not targeting hidden dir: exclude all hidden directories
				args.push("-g", `!**/.*/**`)
			}
			// If targeting hidden dir: don't add any exclusion for hidden directories
			continue
		}

		// When explicitly targeting a directory that's in the ignore list (e.g., "temp"),
		// we need special handling:
		// - Don't add any exclusion pattern for the target directory itself
		// - Only exclude nested subdirectories with the same name
		// This ensures all files in the target directory are listed, while still
		// preventing recursion into nested directories with the same ignored name
		if (dir === targetDirName && isTargetInIgnoreList) {
			// Skip adding any exclusion pattern - we want to see everything in the target directory
			continue
		}

		// For all other cases, exclude the directory pattern globally
		args.push("-g", `!**/${dir}/**`)
	}

	return args
}

/**
 * Build ripgrep arguments for non-recursive directory listing
 */
function buildNonRecursiveArgs(): string[] {
	const args: string[] = []

	// For non-recursive, limit to the current directory level
	args.push("-g", "*")
	args.push("--maxdepth", "1") // ripgrep uses maxdepth, not max-depth

	// Respect .gitignore in non-recursive mode too
	// (ripgrep respects .gitignore by default)

	// Apply directory exclusions for non-recursive searches
	for (const dir of DIRS_TO_IGNORE) {
		if (dir === ".*") {
			// For hidden directories in non-recursive mode, we want to show the directories
			// themselves but not their contents. Since we're using --maxdepth 1, this
			// naturally happens - we just need to avoid excluding the directories entirely.
			// We'll let the directory scanning logic handle the visibility.
			continue
		} else {
			// Direct children only
			args.push("-g", `!${dir}`)
			args.push("-g", `!${dir}/**`)
		}
	}

	return args
}

/**
 * Create an ignore instance that handles .gitignore files properly
 * This replaces the custom gitignore parsing with the proper ignore library
 */
async function createIgnoreInstance(dirPath: string): Promise<ReturnType<typeof ignore>> {
	const ignoreInstance = ignore()
	const absolutePath = path.resolve(dirPath)

	// Find all .gitignore files from the target directory up to the root
	const gitignoreFiles = await findGitignoreFiles(absolutePath)

	// Add patterns from all .gitignore files
	for (const gitignoreFile of gitignoreFiles) {
		try {
			const content = await fs.promises.readFile(gitignoreFile, "utf8")
			ignoreInstance.add(content)
		} catch (err) {
			// Continue if we can't read a .gitignore file
			console.warn(`Could not read .gitignore at ${gitignoreFile}: ${err}`)
		}
	}

	// Always ignore .gitignore files themselves
	ignoreInstance.add(".gitignore")

	return ignoreInstance
}

/**
 * Find all .gitignore files from the given directory up to the workspace root
 */
async function findGitignoreFiles(startPath: string): Promise<string[]> {
	const gitignoreFiles: string[] = []
	let currentPath = startPath

	// Walk up the directory tree looking for .gitignore files
	while (currentPath && currentPath !== path.dirname(currentPath)) {
		const gitignorePath = path.join(currentPath, ".gitignore")

		try {
			await fs.promises.access(gitignorePath)
			gitignoreFiles.push(gitignorePath)
		} catch {
			// .gitignore doesn't exist at this level, continue
		}

		// Move up one directory
		const parentPath = path.dirname(currentPath)
		/* v8 ignore next 3 -- 到達不能: while 条件が currentPath !== path.dirname(currentPath) を保証しているため、ループ本体では parentPath（= dirname）は常に currentPath と異なる。ルート到達時は while 条件側で抜けるので、この break には入らない。二重ガードとして残す。 */
		if (parentPath === currentPath) {
			break // Reached root
		}
		currentPath = parentPath
	}

	// Return in reverse order (root .gitignore first, then more specific ones)
	return gitignoreFiles.reverse()
}

/**
 * List directories with appropriate filtering
 */
async function listFilteredDirectories(
	dirPath: string,
	recursive: boolean,
	ignoreInstance: ReturnType<typeof ignore>,
	limit?: number,
): Promise<string[]> {
	const absolutePath = path.resolve(dirPath)
	const directories: string[] = []
	let dirCount = 0
	/* v8 ignore next -- 到達不能: listFilteredDirectories は呼び出し元（listFiles）から常に Math.max(0, ...) の数値 remainingLimit を渡されるため limit は undefined にならず、?? の右側（MAX_SAFE_INTEGER 既定）へは入らない。API 契約が崩れたときの安全既定として残す。 */
	const effectiveLimit = limit ?? Number.MAX_SAFE_INTEGER

	// For environment details generation, we don't want to treat the root as a "target"
	// if we're doing a general recursive scan, as this would include hidden directories
	// Only treat as target if we're explicitly scanning a single hidden directory
	const isExplicitHiddenTarget = path.basename(absolutePath).startsWith(".")

	// Create initial context for the scan
	const initialContext: ScanContext = {
		isTargetDir: isExplicitHiddenTarget,
		insideExplicitHiddenTarget: isExplicitHiddenTarget,
		basePath: dirPath,
		ignoreInstance,
	}

	async function scanDirectory(currentPath: string, context: ScanContext): Promise<boolean> {
		// Check if we've reached the limit
		if (dirCount >= effectiveLimit) {
			return true // Signal that limit was reached
		}

		try {
			// List all entries in the current directory
			const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })

			// Filter for directories only, excluding symbolic links to prevent circular traversal
			for (const entry of entries) {
				// Check limit before processing each directory
				/* v8 ignore next 3 -- 到達不能: dirCount の増加は必ず直後の 448 行 `if (dirCount >= effectiveLimit) return true` で捕捉され、再帰も上限到達時は 489 行で即 return true するため、次のループ反復の先頭でこの条件が真になる経路は無い。関数入口 413 行のガードと合わせた冗長チェックとして残す。 */
				if (dirCount >= effectiveLimit) {
					return true
				}

				if (entry.isDirectory() && !entry.isSymbolicLink()) {
					const dirName = entry.name
					const fullDirPath = path.join(currentPath, dirName)

					// Create context for subdirectory checks
					// Subdirectories found during scanning are never target directories themselves
					const subdirContext: ScanContext = {
						...context,
						isTargetDir: false,
					}

					// Check if this directory should be included
					if (shouldIncludeDirectory(dirName, fullDirPath, subdirContext)) {
						// Add the directory to our results (with trailing slash)
						// fullDirPath is already absolute since it's built with path.join from absolutePath
						/* v8 ignore next -- 到達不能: fullDirPath は path.join(currentPath, dirName) 由来で path.join が末尾セパレータを常に除去するため endsWith("/") の真側へは入らない。防御的な正規化として残す。 */
						const formattedPath = fullDirPath.endsWith("/") ? fullDirPath : `${fullDirPath}/`
						directories.push(formattedPath)
						dirCount++

						// Check if we've reached the limit after adding
						if (dirCount >= effectiveLimit) {
							return true
						}
					}

					// If recursive mode and not a ignored directory, scan subdirectories
					// Don't recurse into hidden directories unless they are the explicit target
					// or we're already inside an explicitly targeted hidden directory
					const isHiddenDir = dirName.startsWith(".")

					// Use the same logic as shouldIncludeDirectory for recursion decisions
					// When inside an explicitly targeted hidden directory, only block critical directories
					let shouldRecurseIntoDir = true
					if (context.insideExplicitHiddenTarget) {
						// Only apply the most critical ignore patterns when inside explicit hidden target
						shouldRecurseIntoDir = !CRITICAL_IGNORE_PATTERNS.has(dirName)
					} else {
						shouldRecurseIntoDir = !isDirectoryExplicitlyIgnored(dirName)
					}

					const shouldRecurse =
						recursive &&
						shouldRecurseIntoDir &&
						!(
							isHiddenDir &&
							DIRS_TO_IGNORE.includes(".*") &&
							!context.isTargetDir &&
							!context.insideExplicitHiddenTarget
						)
					if (shouldRecurse) {
						// If we're entering a hidden directory that's the target, or we're already inside one,
						// mark that we're inside an explicitly targeted hidden directory
						/* v8 ignore next 2 -- 到達不能: この行に到達するのは shouldRecurse が真のとき。isTargetDir が真になるのは insideExplicitHiddenTarget も真のケースのみ（初期 context で両者は同値、再帰では両者 false）で、その場合 || の左が真で右は評価されない。右の `isHiddenDir && context.isTargetDir` で context.isTargetDir まで進む状態は存在しない（insideExplicit=false かつ isHiddenDir=true では shouldRecurse が偽になり本行へ来ない）。冗長な再判定として残す。 */
						const newInsideExplicitHiddenTarget =
							context.insideExplicitHiddenTarget || (isHiddenDir && context.isTargetDir)
						const newContext: ScanContext = {
							...context,
							isTargetDir: false,
							insideExplicitHiddenTarget: newInsideExplicitHiddenTarget,
						}
						const limitReached = await scanDirectory(fullDirPath, newContext)
						if (limitReached) {
							return true
						}
					}
				}
			}
		} catch (err) {
			// Continue if we can't read a directory
			console.warn(`Could not read directory ${currentPath}: ${err}`)
		}

		return false // Limit not reached
	}

	// Start scanning from the root directory
	await scanDirectory(absolutePath, initialContext)

	return directories
}

/**
 * Critical directories that should always be ignored, even inside explicitly targeted hidden directories
 */
const CRITICAL_IGNORE_PATTERNS = new Set(["node_modules", ".git", "__pycache__", "venv", "env"])

/**
 * Check if a directory matches any of the given patterns
 */
function matchesIgnorePattern(dirName: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (pattern === dirName || (pattern.includes("/") && pattern.split("/")[0] === dirName)) {
			return true
		}
	}
	return false
}

/**
 * Check if a directory is ignored by gitignore
 */
function isIgnoredByGitignore(
	fullDirPath: string,
	basePath: string,
	ignoreInstance: ReturnType<typeof ignore>,
): boolean {
	const relativePath = path.relative(basePath, fullDirPath)
	const normalizedPath = relativePath.replace(/\\/g, "/")
	return ignoreInstance.ignores(normalizedPath) || ignoreInstance.ignores(normalizedPath + "/")
}

/**
 * Check if a target directory should be included
 */
/* v8 ignore start -- 到達不能: 唯一の呼び出し元である shouldIncludeDirectory の `if (context.isTargetDir)` 分岐がデッド（scanDirectory は subdirContext で、getFirstLevelDirectories も context で isTargetDir を必ず false にして shouldIncludeDirectory を呼ぶ）。そのため本関数は listFiles 経由で一度も呼ばれない。挙動を変えないため削除せず残す（デッドコードとして別途報告）。 */
function shouldIncludeTargetDirectory(dirName: string): boolean {
	// Only apply non-hidden-directory ignore rules to target directories
	const nonHiddenIgnorePatterns = DIRS_TO_IGNORE.filter((pattern) => pattern !== ".*")
	return !matchesIgnorePattern(dirName, nonHiddenIgnorePatterns)
}
/* v8 ignore stop */

/**
 * Check if a directory inside an explicitly targeted hidden directory should be included
 */
function shouldIncludeInsideHiddenTarget(dirName: string, fullDirPath: string, context: ScanContext): boolean {
	// Only apply the most critical ignore patterns when inside explicit hidden target
	if (CRITICAL_IGNORE_PATTERNS.has(dirName)) {
		return false
	}

	// Check against gitignore patterns
	return !isIgnoredByGitignore(fullDirPath, context.basePath, context.ignoreInstance)
}

/**
 * Check if a regular directory should be included
 */
function shouldIncludeRegularDirectory(dirName: string, fullDirPath: string, context: ScanContext): boolean {
	// Check against explicit ignore patterns (excluding the ".*" pattern)
	const nonHiddenIgnorePatterns = DIRS_TO_IGNORE.filter((pattern) => pattern !== ".*")
	if (matchesIgnorePattern(dirName, nonHiddenIgnorePatterns)) {
		return false
	}

	// Check against gitignore patterns
	return !isIgnoredByGitignore(fullDirPath, context.basePath, context.ignoreInstance)
}

/**
 * Determine if a directory should be included in results based on filters
 */
function shouldIncludeDirectory(dirName: string, fullDirPath: string, context: ScanContext): boolean {
	// If this is the explicitly targeted directory, allow it even if it's hidden
	// This preserves the ability to explicitly target hidden directories like .agent-memory
	/* v8 ignore next 3 -- 到達不能: 呼び出し元（scanDirectory の subdirContext, getFirstLevelDirectories の context）はいずれも isTargetDir を false 固定で渡すため、この分岐へは入らない。デッドコードとして残す（別途報告）。 */
	if (context.isTargetDir) {
		return shouldIncludeTargetDirectory(dirName)
	}

	// If we're inside an explicitly targeted hidden directory, allow subdirectories
	// even if they would normally be filtered out by the ".*" pattern or other ignore rules
	if (context.insideExplicitHiddenTarget) {
		return shouldIncludeInsideHiddenTarget(dirName, fullDirPath, context)
	}

	// Regular directory inclusion logic
	return shouldIncludeRegularDirectory(dirName, fullDirPath, context)
}

/**
 * Check if a directory is in our explicit ignore list
 */
function isDirectoryExplicitlyIgnored(dirName: string): boolean {
	for (const pattern of DIRS_TO_IGNORE) {
		// Exact name matching
		if (pattern === dirName) {
			return true
		}

		// Skip the ".*" pattern - it's handled specially to allow top-level visibility
		if (pattern === ".*") {
			continue
		}

		// Path patterns that contain /
		if (pattern.includes("/")) {
			const pathParts = pattern.split("/")
			if (pathParts[0] === dirName) {
				return true
			}
		}
	}

	return false
}

/**
 * Combine file and directory results and format them properly
 */
function formatAndCombineResults(files: string[], directories: string[], limit: number): [string[], boolean] {
	// Combine file paths with directory paths
	const allPaths = [...directories, ...files]

	// Deduplicate paths (a directory might appear in both lists)
	const uniquePathsSet = new Set(allPaths)
	const uniquePaths = Array.from(uniquePathsSet)

	// Sort to ensure directories come first, followed by files
	uniquePaths.sort((a: string, b: string) => {
		const aIsDir = a.endsWith("/")
		const bIsDir = b.endsWith("/")

		/* v8 ignore next -- 到達不能: allPaths は [...directories, ...files] とディレクトリ先行で組まれ、V8 の Array.sort（TimSort）は比較関数を常に (後方要素, 前方要素) の順で呼ぶ。よってディレクトリ(先行)が第1引数・ファイル(後方)が第2引数となる (aIsDir && !bIsDir) の組み合わせは発生せず、この return -1 へは入らない（該当ケースは 638 行の (file, dir) 比較で処理される）。冗長な対称分岐として残す。 */
		if (aIsDir && !bIsDir) return -1
		if (!aIsDir && bIsDir) return 1
		return a.localeCompare(b)
	})

	const trimmedPaths = uniquePaths.slice(0, limit)
	return [trimmedPaths, trimmedPaths.length >= limit]
}

/**
 * Execute ripgrep command and return list of files
 */
async function execRipgrep(rgPath: string, args: string[], limit: number): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const rgProcess = childProcess.spawn(rgPath, args)
		let output = ""
		const results: string[] = []

		// Set timeout to avoid hanging
		const timeoutId = setTimeout(() => {
			rgProcess.kill()
			console.warn("ripgrep timed out, returning partial results")
			resolve(results.slice(0, limit))
		}, 10_000)

		// Process stdout data as it comes in
		rgProcess.stdout.on("data", (data) => {
			output += data.toString()
			processRipgrepOutput()

			// Kill the process if we've reached the limit
			if (results.length >= limit) {
				rgProcess.kill()
				clearTimeout(timeoutId) // Clear the timeout when we kill the process due to reaching the limit
			}
		})

		// Process stderr but don't fail on non-zero exit codes
		rgProcess.stderr.on("data", (data) => {
			console.error(`ripgrep stderr: ${data}`)
		})

		// Handle process completion
		rgProcess.on("close", (code) => {
			// Clear the timeout to avoid memory leaks
			clearTimeout(timeoutId)

			// Process any remaining output
			processRipgrepOutput(true)

			// Log non-zero exit codes but don't fail
			if (code !== 0 && code !== null && code !== 143 /* SIGTERM */) {
				console.warn(`ripgrep process exited with code ${code}, returning partial results`)
			}

			resolve(results.slice(0, limit))
		})

		// Handle process errors
		rgProcess.on("error", (error) => {
			// Clear the timeout to avoid memory leaks
			clearTimeout(timeoutId)
			reject(new Error(`ripgrep process error: ${error.message}`))
		})

		// Helper function to process output buffer
		function processRipgrepOutput(isFinal = false) {
			const lines = output.split("\n")

			// Keep the last incomplete line unless this is the final processing
			if (!isFinal) {
				output = lines.pop() || ""
			} else {
				output = ""
			}

			// Process each complete line
			for (const line of lines) {
				if (line.trim() && results.length < limit) {
					// Keep the relative path as returned by ripgrep
					results.push(line)
				} else if (results.length >= limit) {
					break
				}
			}
		}
	})
}
