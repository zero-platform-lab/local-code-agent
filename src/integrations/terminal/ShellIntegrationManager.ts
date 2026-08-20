import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"

import { isPathInside } from "../../utils/pathUtils"

export class ShellIntegrationManager {
	public static terminalTmpDirs: Map<number, string> = new Map()

	/**
	 * Initialize a temporary directory for ZDOTDIR
	 * @param env The environment variables object to modify
	 * @returns The path to the temporary directory
	 */
	public static zshInitTmpDir(env: Record<string, string>): string {
		// Create a temporary directory with the sticky bit set for security
		const tmpDir = path.join(os.tmpdir(), `roo-zdotdir-${Math.random().toString(36).substring(2, 15)}`)
		console.info(`[TerminalRegistry] Creating temporary directory for ZDOTDIR: ${tmpDir}`)

		// Save original ZDOTDIR as ROO_ZDOTDIR
		if (process.env.ZDOTDIR) {
			env.ROO_ZDOTDIR = process.env.ZDOTDIR
		}

		// Create the temporary directory
		vscode.workspace.fs
			.createDirectory(vscode.Uri.file(tmpDir))
			.then(() => {
				console.info(`[TerminalRegistry] Created temporary directory for ZDOTDIR at ${tmpDir}`)

				// Create .zshrc in the temporary directory
				const zshrcPath = `${tmpDir}/.zshrc`

				// Get the path to the shell integration script
				const shellIntegrationPath = this.getShellIntegrationPath("zsh")

				const zshrcContent = `
	source "${shellIntegrationPath}"
	ZDOTDIR=\${ROO_ZDOTDIR:-$HOME}
	unset ROO_ZDOTDIR
	[ -f "$ZDOTDIR/.zshenv" ] && source "$ZDOTDIR/.zshenv"
	[ -f "$ZDOTDIR/.zprofile" ] && source "$ZDOTDIR/.zprofile"
	[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
	[ -f "$ZDOTDIR/.zlogin" ] && source "$ZDOTDIR/.zlogin"
	[ "$ZDOTDIR" = "$HOME" ] && unset ZDOTDIR
	`
				console.info(`[TerminalRegistry] Creating .zshrc file at ${zshrcPath} with content:\n${zshrcContent}`)
				vscode.workspace.fs.writeFile(vscode.Uri.file(zshrcPath), Buffer.from(zshrcContent)).then(
					// Success handler
					() => {
						console.info(`[TerminalRegistry] Successfully created .zshrc file at ${zshrcPath}`)
					},
					// Error handler
					(error: Error) => {
						console.error(`[TerminalRegistry] Error creating .zshrc file at ${zshrcPath}: ${error}`)
					},
				)
			})
			.then(undefined, (error: Error) => {
				console.error(`[TerminalRegistry] Error creating temporary directory at ${tmpDir}: ${error}`)
			})

		return tmpDir
	}

	/**
	 * Clean up a temporary directory used for ZDOTDIR
	 */
	public static zshCleanupTmpDir(terminalId: number): boolean {
		const tmpDir = this.terminalTmpDirs.get(terminalId)

		if (!tmpDir) {
			return false
		}

		const logPrefix = `[TerminalRegistry] Cleaning up temporary directory for terminal ${terminalId}`
		console.info(`${logPrefix}: ${tmpDir}`)

		// terminalTmpDirs は public static で、値は zshInitTmpDir が作った os.tmpdir() 配下の
		// パスしか入らない前提。ただしその前提が破れると、ここは中身を確認せず
		// `<dir>/.zshrc` を unlink して `<dir>` を rmdir する。$HOME が入れば ~/.zshrc が消える。
		// 前提に頼らず、消す前に自分の作業領域かを確かめる。
		// isPathInside は同一パスを true にするので、tmpdir そのものが入っていた場合は
		// `<tmpdir>/.zshrc` の unlink が走ってしまう。自分が作ったサブディレクトリだけを対象にする。
		if (!isPathInside(os.tmpdir(), tmpDir) || path.resolve(tmpDir) === path.resolve(os.tmpdir())) {
			console.error(`${logPrefix}: refusing to clean up a path outside the temp directory: ${tmpDir}`)
			this.terminalTmpDirs.delete(terminalId)
			return false
		}

		try {
			// Use fs to remove the directory and its contents
			// Remove .zshrc file
			const zshrcPath = path.join(tmpDir, ".zshrc")
			if (fs.existsSync(zshrcPath)) {
				console.info(`${logPrefix}: Removing .zshrc file at ${zshrcPath}`)
				fs.unlinkSync(zshrcPath)
			}

			// Remove the directory
			if (fs.existsSync(tmpDir)) {
				console.info(`${logPrefix}: Removing directory at ${tmpDir}`)
				fs.rmdirSync(tmpDir)
			}

			// Remove it from the map
			this.terminalTmpDirs.delete(terminalId)
			console.info(`${logPrefix}: Removed terminal ${terminalId} from temporary directory map`)

			return true
		} catch (error: unknown) {
			console.error(
				`[TerminalRegistry] Error cleaning up temporary directory ${tmpDir}: ${error instanceof Error ? error.message : String(error)}`,
			)

			return false
		}
	}

	public static clear() {
		this.terminalTmpDirs.forEach((_, terminalId) => this.zshCleanupTmpDir(terminalId))
		this.terminalTmpDirs.clear()
	}

	/**
	 * Gets the path to the shell integration script for a given shell type
	 * @param shell The shell type
	 * @returns The path to the shell integration script
	 */
	private static getShellIntegrationPath(shell: "bash" | "pwsh" | "zsh" | "fish"): string {
		let filename: string

		switch (shell) {
			case "bash":
				filename = "shellIntegration-bash.sh"
				break
			case "pwsh":
				filename = "shellIntegration.ps1"
				break
			case "zsh":
				filename = "shellIntegration-rc.zsh"
				break
			case "fish":
				filename = "shellIntegration.fish"
				break
			default:
				throw new Error(`Invalid shell type: ${shell}`)
		}

		// This is the same path used by the CLI command
		return path.join(
			vscode.env.appRoot,
			"out",
			"vs",
			"workbench",
			"contrib",
			"terminal",
			"common",
			"scripts",
			filename,
		)
	}
}
