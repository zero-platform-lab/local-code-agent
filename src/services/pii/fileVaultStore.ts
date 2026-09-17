import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import * as vscode from "vscode"

const FORMAT_VERSION = 1
const KEY_NAME = "pii.fileVault.masterKey.v1"
const AAD = Buffer.from("local-code-agent:file-vault:v1", "utf8")
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

type Envelope = {
	formatVersion: 1
	algorithm: "aes-256-gcm"
	nonce: string
	ciphertext: string
	tag: string
}

export type FileVaultRecord = Readonly<StoredFile>

export type FileVaultPruneResult = {
	expired: number
	missing: number
}

export class FileVaultError extends Error {
	constructor(
		public readonly code: "missingKey" | "corrupt" | "unsupported" | "maxFiles" | "maxEntries" | "maxBytes",
		cause?: unknown,
	) {
		super(code, { cause })
		this.name = "FileVaultError"
	}
}

function emptyCatalog(): Catalog {
	return { formatVersion: FORMAT_VERSION, files: {} }
}

function decodeKey(encoded: string): Buffer {
	const key = Buffer.from(encoded, "base64")
	if (key.length !== 32) throw new FileVaultError("missingKey")
	return key
}

function encrypt(catalog: Catalog, key: Buffer): Uint8Array {
	const nonce = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key, nonce)
	cipher.setAAD(AAD)
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(catalog), "utf8"), cipher.final()])
	const envelope: Envelope = {
		formatVersion: FORMAT_VERSION,
		algorithm: "aes-256-gcm",
		nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
	}
	return Buffer.from(JSON.stringify(envelope), "utf8")
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

function decrypt(raw: Uint8Array, key: Buffer): Catalog {
	try {
		const envelope = JSON.parse(Buffer.from(raw).toString("utf8")) as Partial<Envelope>
		if (envelope.formatVersion !== FORMAT_VERSION || envelope.algorithm !== "aes-256-gcm") {
			throw new FileVaultError("unsupported")
		}
		if (!envelope.nonce || !envelope.ciphertext || !envelope.tag) throw new Error("incomplete envelope")

		const nonce = Buffer.from(envelope.nonce, "base64")
		const tag = Buffer.from(envelope.tag, "base64")
		if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid envelope")
		const decipher = createDecipheriv("aes-256-gcm", key, nonce)
		decipher.setAAD(AAD)
		decipher.setAuthTag(tag)
		const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()])
		const catalog: unknown = JSON.parse(plain.toString("utf8"))
		if (
			catalog &&
			typeof catalog === "object" &&
			"formatVersion" in catalog &&
			catalog.formatVersion !== FORMAT_VERSION
		) {
			throw new FileVaultError("unsupported")
		}
		if (!validCatalog(catalog)) throw new Error("invalid catalog")
		return catalog
	} catch (error) {
		if (error instanceof FileVaultError) throw error
		throw new FileVaultError("corrupt", error)
	}
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && /FileNotFound|EntryNotFound/i.test(error.name)
}

/** ワークスペース固有領域の暗号化カタログ。全操作を直列化して更新の取りこぼしを防ぐ。 */
export class FileVaultStore {
	private tail: Promise<void> = Promise.resolve()
	private readonly target: vscode.Uri

	constructor(
		private readonly root: vscode.Uri,
		private readonly secrets: Pick<vscode.SecretStorage, "get" | "store">,
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
		let raw: Uint8Array
		try {
			raw = await this.fs.readFile(this.target)
		} catch (error) {
			if (isNotFound(error)) return { catalog: emptyCatalog(), exists: false }
			throw error
		}

		const encoded = await this.secrets.get(KEY_NAME)
		if (!encoded) throw new FileVaultError("missingKey")
		return { catalog: decrypt(raw, decodeKey(encoded)), exists: true }
	}

	private async write(catalog: Catalog, existed: boolean): Promise<void> {
		let encoded = await this.secrets.get(KEY_NAME)
		if (!encoded) {
			if (existed) throw new FileVaultError("missingKey")
			encoded = randomBytes(32).toString("base64")
			await this.secrets.store(KEY_NAME, encoded)
		}

		await this.fs.createDirectory(this.root)
		const temporary = vscode.Uri.joinPath(this.root, `${FILE_NAME}.${randomBytes(8).toString("hex")}.tmp`)
		await this.fs.writeFile(temporary, encrypt(catalog, decodeKey(encoded)))
		try {
			await this.fs.rename(temporary, this.target, { overwrite: true })
		} catch (error) {
			try {
				await this.fs.delete(temporary)
			} catch {
				// 元の暗号文を守ることを優先する。一時ファイルの掃除失敗で理由を置き換えない。
			}
			throw error
		}
	}

	list(): Promise<FileVaultRecord[]> {
		return this.exclusive(async () => Object.values((await this.read()).catalog.files))
	}

	load(identity: string): Promise<FileVaultRecord | undefined> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
			const record = catalog.files[identity]
			if (!record) return undefined
			record.lastUsedAt = this.now().toISOString()
			await this.write(catalog, exists)
			return record
		})
	}

	/** 対応を保存する。無ければ作り、あれば足し合わせる（upsert）。 */
	save(identity: string, entries: readonly FileVaultEntry[]): Promise<FileVaultRecord> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
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
			await this.write(catalog, exists)
			return record
		})
	}

	delete(identity: string): Promise<number> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
			const count = catalog.files[identity]?.entries.length
			if (count === undefined) return 0
			delete catalog.files[identity]
			await this.write(catalog, exists)
			return count
		})
	}

	deleteMany(identities: readonly string[]): Promise<{ files: number; entries: number }> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
			const wanted = new Set(identities)
			const targets = Object.entries(catalog.files).filter(([identity]) => wanted.has(identity))
			if (targets.length === 0) return { files: 0, entries: 0 }
			for (const [identity] of targets) delete catalog.files[identity]
			await this.write(catalog, exists)
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
			const { catalog, exists } = await this.read()
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
			await this.write(catalog, exists)
			return moved.length
		})
	}

	/** ファイルまたはディレクトリ以下の関連付けを削除する。 */
	deletePath(identity: string): Promise<{ files: number; entries: number }> {
		return this.exclusive(async () => {
			const { catalog, exists } = await this.read()
			const targets = Object.entries(catalog.files).filter(
				([candidate]) => candidate === identity || candidate.startsWith(`${identity}/`),
			)
			if (targets.length === 0) return { files: 0, entries: 0 }
			for (const [candidate] of targets) delete catalog.files[candidate]
			await this.write(catalog, exists)
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

			if (expired > 0 || missing > 0) await this.write(catalog, exists)
			return { expired, missing }
		})
	}
}
