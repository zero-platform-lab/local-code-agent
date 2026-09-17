import * as path from "node:path"

import * as vscode from "vscode"

import { t } from "../../i18n"

import {
	DEFAULT_FILE_VAULT_LIMITS,
	FileVaultError,
	FileVaultStore,
	type FileVaultEntry,
	type FileVaultLimits,
} from "./fileVaultStore"
import { PiiVault } from "./maskConversation"
import { unmaskText } from "./maskText"

const DEFAULT_RETENTION_DAYS = 30

export function fileVaultIdentity(uri: vscode.Uri): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(uri)
	if (!folder) return undefined
	const relative = path.posix.relative(folder.uri.path, uri.path)
	if (!relative || relative === ".." || relative.startsWith("../")) return undefined
	return `${folder.index}:${relative}`
}

function errorMessage(error: unknown): string {
	if (error instanceof FileVaultError) return t(`common:pii.fileVault.${error.code}`)
	return t("common:pii.fileVault.failed")
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && /FileNotFound|EntryNotFound/i.test(error.name)
}

function uriForIdentity(identity: string): vscode.Uri | undefined {
	const match = /^(\d+):(.+)$/.exec(identity)
	if (!match) return undefined
	const folder = vscode.workspace.workspaceFolders?.[Number(match[1])]
	return folder ? vscode.Uri.joinPath(folder.uri, ...match[2].split("/")) : undefined
}

function uriForToolPath(value: string): vscode.Uri | undefined {
	const folders = vscode.workspace.workspaceFolders ?? []
	const parts = value.trim().replace(/\\/g, "/").split("/")
	if (folders.length === 0 || parts.some((part) => !part || part === "." || part === "..")) return undefined
	let folder = folders[0]
	if (folders.length > 1) {
		folder = folders.find((candidate) => candidate.name === parts[0]) ?? folder
		if (folder.name !== parts[0]) return undefined
		parts.shift()
	}
	return vscode.Uri.joinPath(folder.uri, ...parts)
}

function labelForIdentity(identity: string): string {
	const match = /^(\d+):(.+)$/.exec(identity)
	if (!match) return identity
	const folders = vscode.workspace.workspaceFolders ?? []
	const folder = folders[Number(match[1])]
	return folders.length > 1 && folder ? `${folder.name}/${match[2]}` : match[2]
}

/** 設定の読み取り係。既定は本体の設定へ配線するまでの値。 */
export type FileVaultConfig = {
	retentionDays?: () => number
	limits?: () => FileVaultLimits
}

/**
 * File Vault の実体。送信経路が保存・取り込みに使い、利用者は消去に使う。
 *
 * File Vault を実行するかどうか（`piiMasking.fileVault.enabled`）は呼び出し側が見る。
 * ここは「実行するなら何をするか」だけを持つ。
 */
export class FileVaultController {
	private readonly store: FileVaultStore | undefined
	private readonly retentionDays: () => number
	private readonly limits: () => FileVaultLimits

	constructor(
		context: Pick<vscode.ExtensionContext, "storageUri"> & {
			secrets: Pick<vscode.SecretStorage, "get" | "store">
		},
		config: FileVaultConfig = {},
	) {
		this.retentionDays = config.retentionDays ?? (() => DEFAULT_RETENTION_DAYS)
		this.limits = config.limits ?? (() => DEFAULT_FILE_VAULT_LIMITS)
		this.store = context.storageUri
			? new FileVaultStore(context.storageUri, context.secrets, undefined, undefined, this.limits)
			: undefined
	}

	/** 起動時の掃除と、VS Code が通知する移動・削除への追従を開始する。 */
	start(): vscode.Disposable[] {
		if (!this.store) return []
		void this.cleanup().catch((error) => vscode.window.showErrorMessage(errorMessage(error)))
		return [
			vscode.workspace.onDidRenameFiles((event) => {
				void this.followRenames(event.files).catch((error) =>
					vscode.window.showErrorMessage(errorMessage(error)),
				)
			}),
			vscode.workspace.onDidDeleteFiles((event) => {
				void this.followDeletes(event.files).catch((error) =>
					vscode.window.showErrorMessage(errorMessage(error)),
				)
			}),
		]
	}

	private async identityExists(identity: string): Promise<boolean | undefined> {
		const uri = uriForIdentity(identity)
		if (!uri) return undefined
		try {
			await vscode.workspace.fs.stat(uri)
			return true
		} catch (error) {
			return isNotFound(error) ? false : undefined
		}
	}

	async cleanup(): Promise<void> {
		await this.store?.prune(this.retentionDays(), (identity) => this.identityExists(identity))
	}

	private async followRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		if (!this.store) return
		for (const { oldUri, newUri } of files) {
			const from = fileVaultIdentity(oldUri)
			const to = fileVaultIdentity(newUri)
			if (from && to) await this.store.movePath(from, to)
			else if (from) await this.store.deletePath(from)
		}
	}

	private async followDeletes(files: readonly vscode.Uri[]): Promise<void> {
		if (!this.store) return
		for (const uri of files) {
			const identity = fileVaultIdentity(uri)
			if (identity) await this.store.deletePath(identity)
		}
	}

	/** 読んだファイルの対応を保存する（`FR-PII-25`）。伏せ字が無ければ何もしない。 */
	async record(uri: vscode.Uri, entries: readonly FileVaultEntry[]): Promise<boolean> {
		const identity = fileVaultIdentity(uri)
		if (!identity || !this.store || entries.length === 0) return true
		try {
			await this.cleanup()
			await this.store.save(identity, entries)
			return true
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
			return false
		}
	}

	async recordToolPath(toolPath: string, entries: readonly FileVaultEntry[]): Promise<boolean> {
		const uri = uriForToolPath(toolPath)
		return uri ? this.record(uri, entries) : true
	}

	/** 伏せ字を新しく割り当てる前に、保存済み番号を Session Vault へ取り込む（`FR-PII-25a`）。 */
	async prepare(uri: vscode.Uri, vault: PiiVault): Promise<boolean> {
		const identity = fileVaultIdentity(uri)
		if (!identity || !this.store) return true
		try {
			await this.cleanup()
			const record = await this.store.load(identity)
			if (record) vault.importEntries(record.entries)
			return true
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
			return false
		}
	}

	/** ファイル道具向け。衝突した保存済み伏せ字を今回の番号へ置き換える関数を返す。 */
	async prepareToolPath(toolPath: string, vault: PiiVault): Promise<(text: string) => string> {
		const uri = uriForToolPath(toolPath)
		return uri ? this.prepareReference(uri, vault) : (text) => text
	}

	/** 添付ファイルや選択範囲向け。保存済み対応を取り込み、番号衝突を置き換える。 */
	async prepareReference(uri: vscode.Uri, vault: PiiVault): Promise<(text: string) => string> {
		const identity = fileVaultIdentity(uri)
		if (!identity || !this.store) return (text) => text
		await this.cleanup()
		const record = await this.store.load(identity)
		if (!record) return (text) => text
		const remapped = vault.importEntries(record.entries)
		return (text) => unmaskText(text, remapped)
	}

	async restore(uri: vscode.Uri, text: string, restoreSession: (text: string) => string): Promise<string> {
		const identity = fileVaultIdentity(uri)
		if (!identity || !this.store) return restoreSession(text)
		await this.cleanup()
		const record = await this.store.load(identity)
		return restoreSession(record ? unmaskText(text, new Map(record.entries)) : text)
	}

	/** 選んだファイルの保管庫を消す（`FR-PII-27`）。 */
	async clearSelected(): Promise<void> {
		if (!this.store) {
			await vscode.window.showWarningMessage(t("common:pii.fileVault.workspaceRequired"))
			return
		}
		try {
			await this.cleanup()
			const records = await this.store.list()
			if (records.length === 0) {
				await vscode.window.showInformationMessage(t("common:pii.fileVault.none"))
				return
			}
			const items = records.map((record) => ({
				label: labelForIdentity(record.identity),
				description: t("common:pii.fileVault.entryCount", { count: record.entries.length }),
				identity: record.identity,
				count: record.entries.length,
			}))
			const selected = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				placeHolder: t("common:pii.fileVault.pickClear"),
			})
			if (!selected || selected.length === 0) return
			await this.confirmAndDelete(selected)
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
		}
	}

	/** File Vault と Session Vault をまとめて消す（`FR-PII-27`）。 */
	async clearAll(vault?: PiiVault): Promise<void> {
		if (!this.store) {
			await vscode.window.showWarningMessage(t("common:pii.fileVault.workspaceRequired"))
			return
		}
		try {
			await this.cleanup()
			const records = await this.store.list()
			if (records.length === 0 && (!vault || vault.size === 0)) {
				await vscode.window.showInformationMessage(t("common:pii.fileVault.none"))
				return
			}
			const fileEntries = records.reduce((sum, record) => sum + record.entries.length, 0)
			const sessionEntries = vault?.size ?? 0
			const confirm = t("common:pii.clearVault")
			const answer = await vscode.window.showWarningMessage(
				t("common:pii.fileVault.confirmClearAll", {
					files: records.length,
					fileCount: fileEntries,
					sessionCount: sessionEntries,
				}),
				{ modal: true },
				confirm,
			)
			if (answer !== confirm) return
			const removed = await this.store.deleteMany(records.map((record) => record.identity))
			const clearedSession = vault?.clearSnapshot([...vault.entries.keys()]) ?? 0
			await vscode.window.showInformationMessage(
				t("common:pii.fileVault.clearedAll", {
					files: removed.files,
					fileCount: removed.entries,
					sessionCount: clearedSession,
				}),
			)
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
		}
	}

	private async confirmAndDelete(selected: readonly { identity: string; count: number }[]): Promise<void> {
		if (!this.store) return
		const entries = selected.reduce((sum, item) => sum + item.count, 0)
		const confirm = t("common:pii.clearVault")
		const answer = await vscode.window.showWarningMessage(
			t("common:pii.fileVault.confirmClearMany", { files: selected.length, count: entries }),
			{ modal: true },
			confirm,
		)
		if (answer !== confirm) return
		const removed = await this.store.deleteMany(selected.map((item) => item.identity))
		await vscode.window.showInformationMessage(
			t("common:pii.fileVault.clearedMany", { files: removed.files, count: removed.entries }),
		)
	}
}

/**
 * 送信経路と消去のコマンドが使う共有のコントローラ。
 *
 * **1 つだけ持つ。** 保存先はワークスペース固有なので、拡張の起動で 1 度だけ作る。
 * `activate` で `setFileVaultController` を呼ぶ。設定していなければ、File Vault は動かない
 * だけで、伏せ字化は従来どおり動く。
 */
let sharedController: FileVaultController | undefined

export function fileVaultController(): FileVaultController | undefined {
	return sharedController
}

export function setFileVaultController(controller: FileVaultController | undefined): void {
	sharedController = controller
}
