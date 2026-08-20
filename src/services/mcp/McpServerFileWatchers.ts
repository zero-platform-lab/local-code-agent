import chokidar, { type FSWatcher } from "chokidar"

import type { ServerConfig } from "./serverConfigSchema"

/** 監視対象ファイルが変わったときに呼ばれる。 */
export type ServerFileChangeHandler = (changedPath: string) => Promise<void>

/**
 * 1 サーバぶんの監視対象。
 *
 * `watchPaths` は 1 つの watcher でまとめて監視し、ビルド成果物は別 watcher にする
 * （chokidar への渡し方が配列 / 単一パスで異なるため、構造ごと保つ）。
 */
export interface WatchTargets {
	/** 設定で明示指定された監視パス。 */
	watchPaths: string[]
	/** `args` に `build/index.js` があればそのパス。開発中の再ビルドを拾う慣習的な対象。 */
	buildArtifact?: string
}

/** ビルド成果物とみなす引数の目印。 */
const BUILD_ARTIFACT_MARKER = "build/index.js"

/**
 * サーバ設定から「何を監視すべきか」を決める。
 *
 * stdio 以外（sse / streamable-http）はローカルファイルを持たないので監視しない。
 * I/O を伴わない純粋な判定なので単体でテストできる。
 */
export function resolveWatchTargets(config: ServerConfig): WatchTargets {
	// Only stdio type has args
	if (config.type !== "stdio") {
		return { watchPaths: [] }
	}

	return {
		watchPaths: config.watchPaths && config.watchPaths.length > 0 ? config.watchPaths : [],
		// we use chokidar instead of onDidSaveTextDocument because it doesn't
		// require the file to be open in the editor
		buildArtifact: config.args?.find((arg: string) => arg.includes(BUILD_ARTIFACT_MARKER)),
	}
}

/**
 * サーバごとの chokidar watcher 群を所有する。
 *
 * McpHub が `fileWatchers: Map<string, FSWatcher[]>` を直接持ち、生成・破棄が
 * 3 メソッドに散っていたのを所有権ごと切り出したもの。「何を監視するか」の判定は
 * {@link resolveWatchTargets}（純関数）、「実際に監視する」のがこのクラス。
 */
export class McpServerFileWatchers {
	private readonly watchers = new Map<string, FSWatcher[]>()

	/** 監視中のサーバ数（テスト・診断用）。 */
	get size(): number {
		return this.watchers.size
	}

	/**
	 * サーバの監視対象を購読する。監視対象が無ければ何もしない。
	 *
	 * @param onChange 変更検知時の処理。失敗しても監視は継続する。
	 */
	watch(serverName: string, config: ServerConfig, onChange: ServerFileChangeHandler): void {
		const targets = resolveWatchTargets(config)
		const watchers = this.watchers.get(serverName) ?? []

		const subscribe = (paths: string | string[], describe: (changedPath: string) => string) => {
			const watcher = chokidar.watch(paths, {})

			watcher.on("change", async (changedPath: string) => {
				try {
					await onChange(changedPath)
				} catch (error) {
					console.error(
						`Failed to restart server ${serverName} after change in ${describe(changedPath)}:`,
						error,
					)
				}
			})

			watchers.push(watcher)
		}

		if (targets.watchPaths.length > 0) {
			// 複数パスをまとめて監視するので、ログには実際に変わったパスを出す
			subscribe(targets.watchPaths, (changedPath) => changedPath)
		}

		if (targets.buildArtifact) {
			// 単一パスなので、設定に書かれたパスをそのままログに出す（既存挙動）
			const artifact = targets.buildArtifact
			subscribe(artifact, () => artifact)
		}

		if (watchers.length > 0) {
			this.watchers.set(serverName, watchers)
		}
	}

	/** 特定サーバの watcher を全て閉じる。 */
	removeFor(serverName: string): void {
		const watchers = this.watchers.get(serverName)

		if (watchers) {
			watchers.forEach((watcher) => watcher.close())
			this.watchers.delete(serverName)
		}
	}

	/** 全 watcher を閉じる。 */
	removeAll(): void {
		this.watchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.watchers.clear()
	}
}
