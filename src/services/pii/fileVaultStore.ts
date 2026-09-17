import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

const FORMAT_VERSION = 1
const FILE_NAME = "file-vault.v1.json"

export const DEFAULT_FILE_VAULT_LIMITS = {
	maxFiles: 100,
	maxEntriesPerFile: 1_000,
	maxBytes: 5 * 1024 * 1024,
} as const

export type FileVaultLimits = {
	maxFiles: number
	maxEntriesPerFile: number
	maxBytes: number
}

export type FileVaultEntry = readonly [placeholder: string, value: string]

type StoredFile = {
	identity: string
	savedAt: string
	lastUsedAt: string
	entries: FileVaultEntry[]
}

type Catalog = {
	formatVersion: 1
	files: Record<string, StoredFile>
}

export type FileVaultRecord = Readonly<StoredFile>

export type FileVaultPruneResult = {
	expired: number
	missing: number
}

export class FileVaultError extends Error {
	constructor(
		public readonly code: "corrupt" | "unsupported" | "maxFiles" | "maxEntries" | "maxBytes",
		cause?: unknown,
	) {
		super(code, { cause })
		this.name = "FileVaultError"
	}
}

function emptyCatalog(): Catalog {
	return { formatVersion: FORMAT_VERSION, files: {} }
}

function validCatalog(value: unknown): value is Catalog {
	if (!value || typeof value !== "object") return false
	const candidate = value as Partial<Catalog>
	if (candidate.formatVersion !== FORMAT_VERSION || !candidate.files || typeof candidate.files !== "object") {
		return false
	}
	return Object.entries(candidate.files).every(([identity, record]) => {
		if (!record || typeof record !== "object" || record.identity !== identity) return false
		if (typeof record.savedAt !== "string" || typeof record.lastUsedAt !== "string") return false
		if (!Number.isFinite(Date.parse(record.savedAt)) || !Number.isFinite(Date.parse(record.lastUsedAt)))
			return false
		return (
			Array.isArray(record.entries) &&
			record.entries.every(
				(entry) =>
					Array.isArray(entry) &&
					entry.length === 2 &&
					typeof entry[0] === "string" &&
					/^\{\{[a-z]+-\d{3,}\}\}$/.test(entry[0]) &&
					typeof entry[1] === "string",
			)
		)
	})
}

/**
 * 読んだ内容を、扱える形にする。
 *
 * **平文で置く。** 同じ PII は、ワークスペースのファイルにもタスクの履歴にも平文である。
 * 対応表だけ暗号化しても守りは上がらないので、鍵の管理や喪失の代償を負わない。壊れた・
 * 版が違うときは、誤った値ではなく失敗を出す。
 */
function parse(raw: Uint8Array): Catalog {
	let value: unknown
	try {
		value = JSON.parse(Buffer.from(raw).toString("utf8"))
	} catch (error) {
		throw new FileVaultError("corrupt", error)
	}
	if (value && typeof value === "object" && "formatVersion" in value && value.formatVersion !== FORMAT_VERSION) {
		throw new FileVaultError("unsupported")
	}
	if (!validCatalog(value)) throw new FileVaultError("corrupt")
	return value
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && /FileNotFound|EntryNotFound/i.test(error.name)
}

/** ワークスペース固有領域の対応表（平文の JSON）。全操作を直列化して更新の取りこぼしを防ぐ。 */
export class FileVaultStore {
	private tail: Promise<void> = Promise.resolve()
	private readonly target: vscode.Uri
	/** 保管ディレクトリへ `.gitignore` を置いたか。対応表は平文なので、万一 git 配下でも残さない。 */
	private gitignored = false

	constructor(
		private readonly root: vscode.Uri,
		private readonly fs: Pick<
			typeof vscode.workspace.fs,
			"readFile" | "writeFile" | "createDirectory" | "rename" | "delete"
		> = vscode.workspace.fs,
		private readonly now: () => Date = () => new Date(),
		private readonly limits: () => FileVaultLimits = () => DEFAULT_FILE_VAULT_LIMITS,
	) {
		this.target = vscode.Uri.joinPath(root, FILE_NAME)
	}

	private assertLimits(catalog: Catalog): void {
		const limits = this.limits()
		const records = Object.values(catalog.files)
		if (limits.maxFiles > 0 && records.length > limits.maxFiles) throw new FileVaultError("maxFiles")
		if (
			limits.maxEntriesPerFile > 0 &&
			records.some((record) => record.entries.length > limits.maxEntriesPerFile)
		) {
			throw new FileVaultError("maxEntries")
		}
		if (limits.maxBytes > 0 && Buffer.byteLength(JSON.stringify(catalog), "utf8") > limits.maxBytes) {
			throw new FileVaultError("maxBytes")
		}
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation)
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private async read(): Promise<{ catalog: Catalog; exists: boolean }> {
		try {
			const raw = await this.fs.readFile(this.target)
			return { catalog: parse(raw), exists: true }
		} catch (error) {
			if (isNotFound(error)) return { catalog: emptyCatalog(), exists: false }
			throw error
		}
	}

	/** 保管ディレクトリへ `.gitignore`（すべて無視）を置く。対応表は平文なので、コミットさせない。 */
	private async ensureGitignore(): Promise<void> {
		if (this.gitignored) return
		try {
			await this.fs.writeFile(vscode.Uri.joinPath(this.root, ".gitignore"), Buffer.from("*\n", "utf8"))
		} catch {
			// 保険なので、書けなくても保存は続ける。
		}
		this.gitignored = true
	}

	private async write(catalog: Catalog): Promise<void> {
		await this.fs.createDirectory(this.root)
		await this.ensureGitignore()
		const temporary = vscode.Uri.joinPath(this.root, `${FILE_NAME}.${randomBytes(8).toString("hex")}.tmp`)
		await this.fs.writeFile(temporary, Buffer.from(JSON.stringify(catalog), "utf8"))
		try {
			await this.fs.rename(temporary, this.target, { overwrite: true })
		} catch (error) {
			try {
				await this.fs.delete(temporary)
			} catch {
				// 元のファイルを守ることを優先する。一時ファイルの掃除失敗で理由を置き換えない。
			}
			throw error
		}
	}

	list(): Promise<FileVaultRecord[]> {
		return this.exclusive(async () => Object.values((await this.read()).catalog.files))
	}

	load(identity: string): Promise<FileVaultRecord | undefined> {
		return this.exclusive(async () => {
			const { catalog } = await this.read()
			const record = catalog.files[identity]
			if (!record) return undefined
			record.lastUsedAt = this.now().toISOString()
			await this.write(catalog)
			return record
		})
	}

	/** 対応を保存する。無ければ作り、あれば足し合わせる（upsert）。 */
	save(identity: string, entries: readonly FileVaultEntry[]): Promise<FileVaultRecord> {
		return this.exclusive(async () => {
			const { catalog } = await this.read()
			const timestamp = this.now().toISOString()
			const previous = catalog.files[identity]
			const merged = new Map(previous?.entries ?? [])
			for (const [placeholder, value] of entries) merged.set(placeholder, value)
			const record: StoredFile = {
				identity,
				savedAt: previous?.savedAt ?? timestamp,
				lastUsedAt: timestamp,
				entries: [...merged],
			}
			catalog.files[identity] = record
			this.assertLimits(catalog)
			await this.write(catalog)
			return record
		})
	}

	delete(identity: string): Promise<number> {
		return this.exclusive(async () => {
			const { catalog } = await this.read()
			const count = catalog.files[identity]?.entries.length
			if (count === undefined) return 0
			delete catalog.files[identity]
			await this.write(catalog)
			return count
		})
	}

	deleteMany(identities: readonly string[]): Promise<{ files: number; entries: number }> {
		return this.exclusive(async () => {
			const { catalog } = await this.read()
			const wanted = new Set(identities)
			const targets = Object.entries(catalog.files).filter(([identity]) => wanted.has(identity))
			if (targets.length === 0) return { files: 0, entries: 0 }
			for (const [identity] of targets) delete catalog.files[identity]
			await this.write(catalog)
			return {
				files: targets.length,
				entries: targets.reduce((sum, [, record]) => sum + record.entries.length, 0),
			}
		})
	}

	/** ファイルまたはディレクトリ以下の関連付けを、新しい場所へ原子的に移す。 */
	movePath(from: string, to: string): Promise<number> {
		return this.exclusive(async () => {
			if (from === to) return 0
			const { catalog } = await this.read()
			const moved = Object.entries(catalog.files).filter(
				([identity]) => identity === from || identity.startsWith(`${from}/`),
			)
			if (moved.length === 0) return 0

			const timestamp = this.now().toISOString()
			for (const [identity, record] of moved) {
				const suffix = identity.slice(from.length)
				const destination = `${to}${suffix}`
				delete catalog.files[identity]
				catalog.files[destination] = {
					...record,
					identity: destination,
					lastUsedAt: timestamp,
				}
			}
			this.assertLimits(catalog)
			await this.write(catalog)
			return moved.length
		})
	}

	/** ファイルまたはディレクトリ以下の関連付けを削除する。 */
	deletePath(identity: string): Promise<{ files: number; entries: number }> {
		return this.exclusive(async () => {
			const { catalog } = await this.read()
			const targets = Object.entries(catalog.files).filter(
				([candidate]) => candidate === identity || candidate.startsWith(`${identity}/`),
			)
			if (targets.length === 0) return { files: 0, entries: 0 }
			for (const [candidate] of targets) delete catalog.files[candidate]
			await this.write(catalog)
			return {
				files: targets.length,
				entries: targets.reduce((sum, [, record]) => sum + record.entries.length, 0),
			}
		})
	}

	/** 期限切れ、または存在しない対象だけを削除する。存在確認不能は保持する。 */
	prune(
		retentionDays: number,
		fileExists: (identity: string) => Promise<boolean | undefined>,
	): Promise<FileVaultPruneResult> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
			if (!exists) return { expired: 0, missing: 0 }
			const now = this.now().getTime()
			const retentionMs = Math.max(0, retentionDays) * 24 * 60 * 60 * 1000
			let expired = 0
			let missing = 0

			for (const [identity, record] of Object.entries(catalog.files)) {
				if (retentionDays > 0 && now - Date.parse(record.lastUsedAt) >= retentionMs) {
					delete catalog.files[identity]
					expired++
					continue
				}
				if ((await fileExists(identity)) === false) {
					delete catalog.files[identity]
					missing++
				}
			}

			if (expired > 0 || missing > 0) await this.write(catalog)
			return { expired, missing }
		})
	}
}
