import { createHash } from "node:crypto"
import * as path from "node:path"

import * as vscode from "vscode"

import { t } from "../../i18n"

import {
	DEFAULT_FILE_MAPPING_LIMITS,
	FileMappingError,
	FileMappingStore,
	type FileMappingEntry,
	type FileMappingLimits,
} from "./fileMappingStore"
import { PiiMapping } from "./maskConversation"
import { unmaskText } from "./maskText"

const DEFAULT_RETENTION_DAYS = 30

export function fileMappingIdentity(uri: vscode.Uri): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(uri)
	if (!folder) return undefined
	const relative = path.posix.relative(folder.uri.path, uri.path)
	if (!relative || relative === ".." || relative.startsWith("../")) return undefined
	return `${folder.index}:${relative}`
}

function errorMessage(error: unknown): string {
	if (error instanceof FileMappingError) return t(`common:pii.fileMapping.${error.code}`)
	return t("common:pii.fileMapping.failed")
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
export type FileMappingConfig = {
	retentionDays?: () => number
	limits?: () => FileMappingLimits
	/** 保管ルートの絶対パス（`FR-PII-24d`）。空なら拡張専用領域を使う。 */
	root?: () => string | undefined
}

/**
 * ファイル対応表の実体。送信経路が保存・取り込みに使い、利用者は消去に使う。
 *
 * ファイル対応表を実行するかどうか（`piiMasking.fileMapping.enabled`）は呼び出し側が見る。
 * ここは「実行するなら何をするか」だけを持つ。
 */
type RootWarning = { key: "rootInsideWorkspace" | "rootNotAbsolute"; path: string }

/** ワークスペースごとの区画名。同じルートを複数のワークスペースで共有しても衝突しない。 */
function mappingWorkspaceKey(): string {
	const id = vscode.workspace.workspaceFile?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
	return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

/** 解決したルートが、いずれかのワークスペースフォルダの内側かどうか。 */
function rootInsideWorkspace(root: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
		const relative = path.relative(folder.uri.fsPath, root)
		return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
	})
}

/**
 * 保管ルートを決める（`FR-PII-24d` `FR-PII-24e`）。
 *
 * 空なら拡張専用領域（storageUri）。絶対パスならその下にワークスペースの区画を作る。絶対パスで
 * なければ使わず storageUri へ戻し、警告を返す。ワークスペース内を指すときは、使うが警告を返す。
 */
function resolveMappingRoot(
	configured: string,
	storageUri: vscode.Uri | undefined,
): { root: vscode.Uri | undefined; warning: RootWarning | undefined } {
	if (!configured) return { root: storageUri, warning: undefined }
	if (!path.isAbsolute(configured)) {
		return { root: storageUri, warning: { key: "rootNotAbsolute", path: configured } }
	}
	const root = vscode.Uri.joinPath(vscode.Uri.file(configured), mappingWorkspaceKey())
	const warning: RootWarning | undefined = rootInsideWorkspace(configured)
		? { key: "rootInsideWorkspace", path: configured }
		: undefined
	return { root, warning }
}

export class FileMappingController {
	private readonly store: FileMappingStore | undefined
	private readonly retentionDays: () => number
	private readonly limits: () => FileMappingLimits
	private readonly rootWarning: RootWarning | undefined

	constructor(context: Pick<vscode.ExtensionContext, "storageUri">, config: FileMappingConfig = {}) {
		this.retentionDays = config.retentionDays ?? (() => DEFAULT_RETENTION_DAYS)
		this.limits = config.limits ?? (() => DEFAULT_FILE_MAPPING_LIMITS)
		const resolved = resolveMappingRoot(config.root?.()?.trim() ?? "", context.storageUri)
		this.rootWarning = resolved.warning
		this.store = resolved.root ? new FileMappingStore(resolved.root, undefined, undefined, this.limits) : undefined
	}

	/** 起動時の掃除と、VS Code が通知する移動・削除への追従を開始する。 */
	start(): vscode.Disposable[] {
		if (this.rootWarning) {
			void vscode.window.showWarningMessage(
				t(`common:pii.fileMapping.${this.rootWarning.key}`, { path: this.rootWarning.path }),
			)
		}
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
			const from = fileMappingIdentity(oldUri)
			const to = fileMappingIdentity(newUri)
			if (from && to) await this.store.movePath(from, to)
			else if (from) await this.store.deletePath(from)
		}
	}

	private async followDeletes(files: readonly vscode.Uri[]): Promise<void> {
		if (!this.store) return
		for (const uri of files) {
			const identity = fileMappingIdentity(uri)
			if (identity) await this.store.deletePath(identity)
		}
	}

	/** 読んだファイルの対応を保存する（`FR-PII-25`）。伏せ字が無ければ何もしない。 */
	async record(uri: vscode.Uri, entries: readonly FileMappingEntry[]): Promise<boolean> {
		const identity = fileMappingIdentity(uri)
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

	async recordToolPath(toolPath: string, entries: readonly FileMappingEntry[]): Promise<boolean> {
		const uri = uriForToolPath(toolPath)
		return uri ? this.record(uri, entries) : true
	}

	/** 伏せ字を新しく割り当てる前に、保存済み番号をセッション対応表へ取り込む（`FR-PII-25a`）。 */
	async prepare(uri: vscode.Uri, mapping: PiiMapping): Promise<boolean> {
		const identity = fileMappingIdentity(uri)
		if (!identity || !this.store) return true
		try {
			await this.cleanup()
			const record = await this.store.load(identity)
			if (record) mapping.importEntries(record.entries)
			return true
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
			return false
		}
	}

	/** ファイル道具向け。衝突した保存済み伏せ字を今回の番号へ置き換える関数を返す。 */
	async prepareToolPath(toolPath: string, mapping: PiiMapping): Promise<(text: string) => string> {
		const uri = uriForToolPath(toolPath)
		return uri ? this.prepareReference(uri, mapping) : (text) => text
	}

	/** 添付ファイルや選択範囲向け。保存済み対応を取り込み、番号衝突を置き換える。 */
	async prepareReference(uri: vscode.Uri, mapping: PiiMapping): Promise<(text: string) => string> {
		const identity = fileMappingIdentity(uri)
		if (!identity || !this.store) return (text) => text
		await this.cleanup()
		const record = await this.store.load(identity)
		if (!record) return (text) => text
		const remapped = mapping.importEntries(record.entries)
		return (text) => unmaskText(text, remapped)
	}

	async restore(uri: vscode.Uri, text: string, restoreSession: (text: string) => string): Promise<string> {
		const identity = fileMappingIdentity(uri)
		if (!identity || !this.store) return restoreSession(text)
		await this.cleanup()
		const record = await this.store.load(identity)
		return restoreSession(record ? unmaskText(text, new Map(record.entries)) : text)
	}

	/** 選んだファイルの対応表を消す（`FR-PII-27`）。 */
	async clearSelected(): Promise<void> {
		if (!this.store) {
			await vscode.window.showWarningMessage(t("common:pii.fileMapping.workspaceRequired"))
			return
		}
		try {
			await this.cleanup()
			const records = await this.store.list()
			if (records.length === 0) {
				await vscode.window.showInformationMessage(t("common:pii.fileMapping.none"))
				return
			}
			const items = records.map((record) => ({
				label: labelForIdentity(record.identity),
				description: t("common:pii.fileMapping.entryCount", { count: record.entries.length }),
				identity: record.identity,
				count: record.entries.length,
			}))
			const selected = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				placeHolder: t("common:pii.fileMapping.pickClear"),
			})
			if (!selected || selected.length === 0) return
			await this.confirmAndDelete(selected)
		} catch (error) {
			await vscode.window.showErrorMessage(errorMessage(error))
		}
	}

	/** ファイル対応表とセッション対応表をまとめて消す（`FR-PII-27`）。 */
	async clearAll(mapping?: PiiMapping): Promise<void> {
		if (!this.store) {
			await vscode.window.showWarningMessage(t("common:pii.fileMapping.workspaceRequired"))
			return
		}
		try {
			await this.cleanup()
			const records = await this.store.list()
			if (records.length === 0 && (!mapping || mapping.size === 0)) {
				await vscode.window.showInformationMessage(t("common:pii.fileMapping.none"))
				return
			}
			const fileEntries = records.reduce((sum, record) => sum + record.entries.length, 0)
			const sessionEntries = mapping?.size ?? 0
			const confirm = t("common:pii.clearMapping")
			const answer = await vscode.window.showWarningMessage(
				t("common:pii.fileMapping.confirmClearAll", {
					files: records.length,
					fileCount: fileEntries,
					sessionCount: sessionEntries,
				}),
				{ modal: true },
				confirm,
			)
			if (answer !== confirm) return
			const removed = await this.store.deleteMany(records.map((record) => record.identity))
			const clearedSession = mapping?.clearSnapshot([...mapping.entries.keys()]) ?? 0
			await vscode.window.showInformationMessage(
				t("common:pii.fileMapping.clearedAll", {
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
		const confirm = t("common:pii.clearMapping")
		const answer = await vscode.window.showWarningMessage(
			t("common:pii.fileMapping.confirmClearMany", { files: selected.length, count: entries }),
			{ modal: true },
			confirm,
		)
		if (answer !== confirm) return
		const removed = await this.store.deleteMany(selected.map((item) => item.identity))
		await vscode.window.showInformationMessage(
			t("common:pii.fileMapping.clearedMany", { files: removed.files, count: removed.entries }),
		)
	}
}

/**
 * 送信経路と消去のコマンドが使う共有のコントローラ。
 *
 * **1 つだけ持つ。** 保存先はワークスペース固有なので、拡張の起動で 1 度だけ作る。
 * `activate` で `setFileMappingController` を呼ぶ。設定していなければ、ファイル対応表は動かない
 * だけで、伏せ字化は従来どおり動く。
 */
let sharedController: FileMappingController | undefined

export function fileMappingController(): FileMappingController | undefined {
	return sharedController
}

export function setFileMappingController(controller: FileMappingController | undefined): void {
	sharedController = controller
}
