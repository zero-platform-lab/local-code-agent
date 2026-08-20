import { defaultModeSlug } from "../../shared/modes"

/**
 * Task の「どの mode / どの provider profile で走っているか」という状態と、その
 * **初期化の非同期性**をまとめて所有する collaborator。
 *
 * 分割前は Task が `_taskMode` / `_taskApiConfigName` / `taskModeReady` /
 * `taskApiConfigReady` の 4 field と、constructor 内の `historyItem ? 即値 : async 初期化`
 * 分岐、さらに `initializeTaskModeAndApiConfig.ts` の 2 関数（host の private field を
 * 外から書き換える形）に分散していた。ここでは「値を持つ人が初期化も知っている」形に
 * 統合し、Task 側は proxy accessor だけを残す。
 *
 * vscode 非依存なので単体テストが素で書ける（provider は下の narrow interface だけ要求）。
 */

/** 初期化に必要な provider の最小表面。`TaskProviderRef` が構造的に満たす。 */
export interface TaskModeStateProvider {
	getState(): Promise<{ mode?: string; currentApiConfigName?: string } | undefined>
	log(message: string): void
}

/** 履歴から復元するときの入力（HistoryItem の必要部分だけ）。 */
export interface TaskModeStateHistory {
	mode?: string
	apiConfigName?: string
}

export class TaskModeState {
	private _mode: string | undefined
	private _apiConfigName: string | undefined

	/** 初期化済みで生成した場合は即 resolve 済み。`fromProvider` だけが差し替える。 */
	private _modeReady: Promise<void> = Promise.resolve()
	private _apiConfigReady: Promise<void> = Promise.resolve()

	private constructor(mode: string | undefined, apiConfigName: string | undefined) {
		this._mode = mode
		this._apiConfigName = apiConfigName
	}

	/**
	 * 履歴再開。値は HistoryItem から既知なので readiness は即 resolve。
	 * apiConfigName は旧タスクだと未永続化 = undefined を返し得る（互換のため許容）。
	 */
	public static fromHistoryItem(historyItem: TaskModeStateHistory): TaskModeState {
		return new TaskModeState(historyItem.mode || defaultModeSlug, historyItem.apiConfigName)
	}

	/**
	 * 新規 task。provider state から非同期に解決する。2 本の promise は独立に
	 * 進む（mode だけ待ちたい呼び出し元が api config を待たされないよう分けている）。
	 */
	public static fromProvider(provider: TaskModeStateProvider): TaskModeState {
		const state = new TaskModeState(undefined, undefined)

		state._modeReady = state.initializeMode(provider)
		state._apiConfigReady = state.initializeApiConfigName(provider)

		return state
	}

	// --- 値 ---

	public get mode(): string | undefined {
		return this._mode
	}

	public set mode(value: string | undefined) {
		this._mode = value
	}

	public get apiConfigName(): string | undefined {
		return this._apiConfigName
	}

	public set apiConfigName(value: string | undefined) {
		this._apiConfigName = value
	}

	// --- readiness ---

	public get modeReady(): Promise<void> {
		return this._modeReady
	}

	public get apiConfigReady(): Promise<void> {
		return this._apiConfigReady
	}

	/** 初期化完了後の mode。未設定なら defaultModeSlug に fallback。 */
	public async getMode(): Promise<string> {
		await this._modeReady
		return this._mode || defaultModeSlug
	}

	/**
	 * sync 版。未初期化で読むと throw する（呼ぶ側が `modeReady` を通した後である
	 * ことを保証している前提の getter）。
	 */
	public requireMode(): string {
		if (this._mode === undefined) {
			throw new Error(
				"Task mode accessed before initialization. Use getTaskMode() or await waitForModeInitialization().",
			)
		}

		return this._mode
	}

	/** 初期化完了後の API config 名。旧タスク互換で undefined を返し得る。 */
	public async getApiConfigName(): Promise<string | undefined> {
		await this._apiConfigReady
		return this._apiConfigName
	}

	// --- 初期化 ---

	/** provider state 取得失敗時は defaultModeSlug に fallback する（既存動作）。 */
	private async initializeMode(provider: TaskModeStateProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._mode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._mode = defaultModeSlug
			// Use the provider's log method for better error visibility
			provider.log(`Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * 取得失敗時は "default" に fallback。
	 *
	 * 並行実行への配慮: state 待ちの間にユーザーが profile を切り替えた場合、
	 * 既に新しい値が入っている可能性がある。その場合は上書きしない。
	 */
	private async initializeApiConfigName(provider: TaskModeStateProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this._apiConfigName === undefined) {
				this._apiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this._apiConfigName === undefined) {
				this._apiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			provider.log(
				`Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}
