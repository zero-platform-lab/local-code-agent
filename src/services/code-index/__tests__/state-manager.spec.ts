import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexStateManager } from "../state-manager"

// vscode の EventEmitter を「実際にリスナーへ配信する」最小実装で差し替える。
// グローバルの __mocks__/vscode.js の fire は no-op のため、
// onProgressUpdate の発火検証ができない。ここでは本物同様に配信する実装を用意する。
vi.mock("vscode", () => {
	class EventEmitter<T> {
		private listeners: Array<(e: T) => void> = []
		public event = (listener: (e: T) => void) => {
			this.listeners.push(listener)
			return {
				dispose: () => {
					this.listeners = this.listeners.filter((l) => l !== listener)
				},
			}
		}
		public fire = (data: T) => {
			this.listeners.forEach((l) => l(data))
		}
		public dispose = () => {
			this.listeners = []
		}
	}
	return { EventEmitter }
})

describe("CodeIndexStateManager", () => {
	let manager: CodeIndexStateManager
	let events: Array<ReturnType<CodeIndexStateManager["getCurrentStatus"]>>

	beforeEach(() => {
		manager = new CodeIndexStateManager()
		events = []
		manager.onProgressUpdate((status) => {
			events.push(status)
		})
	})

	describe("初期状態", () => {
		it("Standby から始まり、カウンタは既定値", () => {
			expect(manager.state).toBe("Standby")
			expect(manager.getCurrentStatus()).toEqual({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
			})
		})
	})

	describe("setSystemState", () => {
		it("状態もメッセージも変わらないときは発火しない", () => {
			// 現在 Standby / message "" のまま同じ状態を投げる（message 省略）
			manager.setSystemState("Standby")
			expect(events).toHaveLength(0)
			expect(manager.state).toBe("Standby")
		})

		it("同じ状態・同じメッセージなら発火しない", () => {
			manager.setSystemState("Error", "boom")
			events.length = 0
			// 同じ state・同じ message → stateChanged=false
			manager.setSystemState("Error", "boom")
			expect(events).toHaveLength(0)
		})

		it("同じ状態でもメッセージが変われば発火する", () => {
			manager.setSystemState("Error", "boom")
			events.length = 0
			manager.setSystemState("Error", "different")
			expect(events).toHaveLength(1)
			expect(manager.getCurrentStatus().message).toBe("different")
		})

		it("Indexing への遷移ではカウンタをリセットしない", () => {
			// まず Indexing でカウンタを進める
			manager.reportBlockIndexingProgress(3, 10)
			expect(manager.getCurrentStatus().processedItems).toBe(3)
			// 別メッセージで Indexing のまま更新 → newState === "Indexing" なので非リセット
			manager.setSystemState("Indexing", "still indexing")
			const s = manager.getCurrentStatus()
			expect(s.systemStatus).toBe("Indexing")
			expect(s.processedItems).toBe(3)
			expect(s.totalItems).toBe(10)
		})

		it("Standby へ遷移しメッセージ省略なら 'Ready.' を既定にしカウンタをリセット", () => {
			manager.reportBlockIndexingProgress(5, 5)
			manager.setSystemState("Standby")
			const s = manager.getCurrentStatus()
			expect(s.systemStatus).toBe("Standby")
			expect(s.message).toBe("Ready.")
			expect(s.processedItems).toBe(0)
			expect(s.totalItems).toBe(0)
			expect(s.currentItemUnit).toBe("blocks")
		})

		it("Indexed へ遷移しメッセージ省略なら 'Index up-to-date.'", () => {
			manager.reportBlockIndexingProgress(1, 1)
			manager.setSystemState("Indexed")
			expect(manager.getCurrentStatus().message).toBe("Index up-to-date.")
		})

		it("Error へ遷移しメッセージ省略なら 'An error occurred.'", () => {
			manager.reportBlockIndexingProgress(1, 1)
			manager.setSystemState("Error")
			expect(manager.getCurrentStatus().message).toBe("An error occurred.")
		})

		it("非 Indexing 状態でも明示メッセージがあれば既定を上書きしない", () => {
			manager.setSystemState("Standby", "explicit")
			expect(manager.getCurrentStatus().message).toBe("explicit")
		})
	})

	describe("reportBlockIndexingProgress", () => {
		it("Standby から Indexing へ切り替え、blocks メッセージを組み立てて発火", () => {
			manager.reportBlockIndexingProgress(2, 8)
			const s = manager.getCurrentStatus()
			expect(s.systemStatus).toBe("Indexing")
			expect(s.processedItems).toBe(2)
			expect(s.totalItems).toBe(8)
			expect(s.currentItemUnit).toBe("blocks")
			expect(s.message).toBe("Indexed 2 / 8 blocks found")
			expect(events).toHaveLength(1)
		})

		it("Stopping 中は進捗で上書きしない（早期 return）", () => {
			manager.setSystemState("Stopping", "stopping")
			events.length = 0
			manager.reportBlockIndexingProgress(9, 9)
			expect(events).toHaveLength(0)
			expect(manager.state).toBe("Stopping")
		})

		it("Indexing 中に同じ進捗を再報告しても発火しない", () => {
			manager.reportBlockIndexingProgress(4, 10)
			events.length = 0
			// progressChanged=false かつ既に Indexing → ブロックに入らない
			manager.reportBlockIndexingProgress(4, 10)
			expect(events).toHaveLength(0)
		})

		it("Indexing 中に進捗が変われば発火する（oldStatus===Indexing 経路）", () => {
			// 1回目で Indexing 化。2回目は既に Indexing かつ progressChanged=true。
			// oldStatus は "Indexing" なので if の第1条件は false、第2条件(message変化)で true。
			manager.reportBlockIndexingProgress(2, 8)
			events.length = 0
			manager.reportBlockIndexingProgress(5, 8)
			expect(events).toHaveLength(1)
			expect(manager.getCurrentStatus().message).toBe("Indexed 5 / 8 blocks found")
		})
	})

	describe("reportFileQueueProgress", () => {
		it("処理途中は 'Processing' メッセージ（basename あり）", () => {
			manager.reportFileQueueProgress(1, 3, "foo.ts")
			const s = manager.getCurrentStatus()
			expect(s.systemStatus).toBe("Indexing")
			expect(s.currentItemUnit).toBe("files")
			expect(s.message).toBe("Processing 1 / 3 files. Current: foo.ts")
			expect(events).toHaveLength(1)
		})

		it("basename 省略時は 'Current: ...'", () => {
			manager.reportFileQueueProgress(1, 3)
			expect(manager.getCurrentStatus().message).toBe("Processing 1 / 3 files. Current: ...")
		})

		it("全件処理済みは 'Finished processing'", () => {
			manager.reportFileQueueProgress(3, 3)
			expect(manager.getCurrentStatus().message).toBe("Finished processing 3 files from queue.")
		})

		it("total 0 は 'File queue processed.'", () => {
			manager.reportFileQueueProgress(0, 0)
			expect(manager.getCurrentStatus().message).toBe("File queue processed.")
		})

		it("Stopping 中は進捗で上書きしない（早期 return）", () => {
			manager.setSystemState("Stopping", "stopping")
			events.length = 0
			manager.reportFileQueueProgress(1, 2, "bar.ts")
			expect(events).toHaveLength(0)
			expect(manager.state).toBe("Stopping")
		})

		it("Indexing 中に同じ進捗を再報告しても発火しない", () => {
			manager.reportFileQueueProgress(2, 5, "x.ts")
			events.length = 0
			manager.reportFileQueueProgress(2, 5, "x.ts")
			expect(events).toHaveLength(0)
		})

		it("メッセージも状態も進捗も変わらない場合はブロックに入っても発火しない", () => {
			// message="File queue processed." / processed=0 / total=0 を Standby で用意。
			// setSystemState は Indexing 以外なのでカウンタを 0 にリセットする。
			manager.setSystemState("Standby", "File queue processed.")
			events.length = 0
			// progressChanged=false だが status!==Indexing なのでブロックには入る。
			// しかし oldStatus(Indexing)===systemStatus, oldMessage===message, !progressChanged で発火しない。
			manager.reportFileQueueProgress(0, 0)
			expect(events).toHaveLength(0)
			// 内部状態は Indexing に遷移している
			expect(manager.state).toBe("Indexing")
		})
	})

	describe("dispose", () => {
		it("EventEmitter を破棄し以後の発火はリスナーへ届かない", () => {
			manager.dispose()
			manager.setSystemState("Error", "after dispose")
			expect(events).toHaveLength(0)
		})
	})
})
