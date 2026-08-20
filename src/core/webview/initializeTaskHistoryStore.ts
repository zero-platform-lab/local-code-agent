import { type HistoryItem } from "@openai-agent/types"

/** マイグレーションで必要な TaskHistoryStore の最小表面。 */
export interface MigratableTaskHistoryStore {
	initialize(): Promise<void>
	migrateFromGlobalState(legacyHistory: HistoryItem[]): Promise<void>
}

export interface TaskHistoryStoreInitDeps {
	store: MigratableTaskHistoryStore
	/** globalState からマイグレーション済みフラグを読む。 */
	getMigratedFlag(key: string): boolean | undefined
	/** globalState から旧形式のタスク履歴配列を読む（無ければ []）。 */
	getLegacyHistory(): HistoryItem[]
	/** globalState にマイグレーション済みフラグを立てる。 */
	setMigratedFlag(key: string): Promise<void>
	log(message: string): void
}

const MIGRATION_KEY = "taskHistoryMigratedToFiles"

/**
 * TaskHistoryStore の初期化と、初回起動時の globalState → per-task ファイルへの
 * マイグレーションを実行する。ClineProvider.initializeTaskHistoryStore の本体。
 * @returns 初期化が成功したか（呼び出し側の taskHistoryStoreInitialized フラグ用）。
 */
export async function runTaskHistoryStoreInitialization(deps: TaskHistoryStoreInitDeps): Promise<boolean> {
	try {
		await deps.store.initialize()

		// Migration: backfill per-task files from globalState on first run
		const alreadyMigrated = deps.getMigratedFlag(MIGRATION_KEY)

		if (!alreadyMigrated) {
			const legacyHistory = deps.getLegacyHistory()

			if (legacyHistory.length > 0) {
				deps.log(`[initializeTaskHistoryStore] Migrating ${legacyHistory.length} entries from globalState`)
				await deps.store.migrateFromGlobalState(legacyHistory)
			}

			await deps.setMigratedFlag(MIGRATION_KEY)
			deps.log("[initializeTaskHistoryStore] Migration complete")
		}

		return true
	} catch (error) {
		deps.log(`[initializeTaskHistoryStore] Error: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
}
