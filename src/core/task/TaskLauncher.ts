/**
 * 「この task はどう始まるか」を所有する collaborator。
 *
 * 分割前は起動判断が 2 箇所に重複していた:
 *   - constructor: `startTask` option が true なら `task || images ? startTask() : resume()`
 *   - `Task.start()`: `metadata` から `task || images` を見て `startTask()`（resume 経路なし）
 *
 * `metadata` は historyItem 再開時に `{ task: historyItem.task, images: [] }` になるため、
 * 後者は「historyItem の task を新規 task 本文として渡す」誤った経路を持っていた
 * （production では historyItem + `startTask: false` の組み合わせが存在しないため
 * 顕在化していない）。起動元を `TaskLaunchSource` として構築時に 1 度だけ確定させ、
 * 起動済みフラグもここが持つことで、この分岐は 1 箇所に収束する。
 */
export type TaskLaunchSource =
	| { kind: "fresh"; task?: string; images?: string[] }
	| { kind: "history" }
	/** 起動元なし。`startTask: false` かつ task/images/historyItem 未指定のときだけ起きる。 */
	| { kind: "none" }

/** 実際の起動処理。Task 本体が持つ lifecycle メソッドを注入する。 */
export interface TaskLaunchTargets {
	startTask(task?: string, images?: string[]): Promise<void>
	resumeTaskFromHistory(): Promise<void>
}

export class TaskLauncher {
	private started = false

	constructor(
		private readonly source: TaskLaunchSource,
		private readonly targets: TaskLaunchTargets,
	) {}

	/**
	 * constructor の option から起動元を決める。`task || images` が historyItem より
	 * 優先されるのは分割前の constructor 分岐と同じ順序。
	 */
	public static sourceFrom(options: { task?: string; images?: string[]; historyItem?: unknown }): TaskLaunchSource {
		if (options.task || options.images) {
			return { kind: "fresh", task: options.task, images: options.images }
		}

		if (options.historyItem) {
			return { kind: "history" }
		}

		return { kind: "none" }
	}

	public get isStarted(): boolean {
		return this.started
	}

	public get kind(): TaskLaunchSource["kind"] {
		return this.source.kind
	}

	/**
	 * 起動する。2 回目以降は no-op（constructor 起動済みの task に対する
	 * 明示 `start()` 呼び出しを吸収する）。
	 */
	public start(): Promise<void> {
		if (this.started) {
			return Promise.resolve()
		}

		this.started = true

		switch (this.source.kind) {
			case "fresh":
				return this.targets.startTask(this.source.task, this.source.images)
			case "history":
				return this.targets.resumeTaskFromHistory()
			case "none":
				return Promise.resolve()
		}
	}
}
