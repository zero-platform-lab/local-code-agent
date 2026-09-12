import type { AgentMessage, PiiMasking } from "@openai-agent/types"

import { readDictionaries } from "./dictionary"
import { maskConversation, PiiVault, type MaskMemo } from "./maskConversation"
import { applyPlan, planMasking, type MaskOptions } from "./maskText"
import type { PiiKind, PiiTerm } from "./types"

/**
 * タスク 1 つ分の伏せ字。
 *
 * **目的。** 送信の直前に伏せ、応答をファイルへ書き戻す前に戻す（`FR-PII-01`
 * `FR-PII-02a`）。設定と対応表を 1 か所に持ち、要求の経路には関数を 2 つ渡すだけにする。
 *
 * **仕組み。** 対応表はタスクの間ずっと持つ（`FR-PII-02b`）。同じ値へ毎回同じ伏せ字を
 * 割り当てないと、前の応答で使った伏せ字と食い違い、モデルは別人だと読む。ディスクへは
 * 書かない。
 *
 * 辞書は**最初の要求のときに 1 度だけ読む**。要求のたびに読むと、送信の手前でファイルの
 * 入出力が増える。読めなくても置き換えは続ける（`FR-PII-03d`）。
 *
 * **戻さない選び方もある**（`FR-PII-19`）。文書を清書させるときは、モデルが書いた伏せ字を
 * そのまま残したい。その場合 `unmask` は素通しする。
 */
export class TaskPiiMasker {
	private readonly vault = new PiiVault()
	private terms: PiiTerm[] | undefined
	private loadedFrom: string | undefined
	private troubles: string[] = []
	private readonly read: () => PiiMasking | undefined
	/** 最後に読めた設定。読めなくなっても、伏せる側を黙って切らないために持つ。 */
	private lastKnown: PiiMasking = {}
	/** 伏せた結果の覚え書き。設定が変わったら捨てる。 */
	private readonly memo: MaskMemo = new Map()

	/**
	 * **設定は要求のたびに読み直す。** 会話の途中で切り替えられるボタンを画面に置いた以上
	 * （`FR-PII-01b`）、抱え込むと押しても効かない。利用者は伏せたつもりで送ってしまう。
	 *
	 * 対応表だけは持ち越す。番号が振り直されると、前の応答の伏せ字が別の値を指す。
	 */
	constructor(read: (() => PiiMasking | undefined) | PiiMasking) {
		this.read = typeof read === "function" ? read : () => read
	}

	/**
	 * **読めなくなったら、最後に読めた設定を使う。**
	 *
	 * 参照先が消えている（画面を閉じた、provider を作り直した）ときに空を返すと、伏せる
	 * 側が黙って切れる。利用者には何も出ないまま、伏せていない要求が送られる。守る側の
	 * 機能が、読めなくなったことを理由に外れてはいけない。
	 */
	private get settings(): PiiMasking {
		const current = this.read()
		if (current) {
			this.lastKnown = current
		}
		return this.lastKnown
	}

	/** シークレットモードが入っているか（`FR-PII-01a`）。 */
	get enabled(): boolean {
		return this.settings.enabled === true
	}

	/** 応答の伏せ字を元の値へ戻すか（`FR-PII-19`）。既定は戻す。 */
	get restores(): boolean {
		return this.settings.restore !== false
	}

	private async options(): Promise<MaskOptions> {
		const settings = this.settings
		// 辞書は読み直さない。ただし**指す先が変わったら読み直す**。設定の画面で辞書を
		// 足しても効かない、という取り違えを避ける。
		//
		// **鍵は伏せ方に効く設定を全部含める。** 辞書だけを見ていると、種類を足しても
		// 覚えていた結果を返し、増やした種類が効かない。
		const key = JSON.stringify([
			settings.dictionaryPaths ?? [],
			settings.terms ?? [],
			settings.kinds ?? [],
			settings.secretLabels ?? [],
		])
		if (this.terms === undefined || this.loadedFrom !== key) {
			this.loadedFrom = key
			// 設定が変われば、覚えていた結果はもう当てにならない。
			this.memo.clear()
			const fromFiles = await readDictionaries(settings.dictionaryPaths ?? [])
			this.terms = [...(settings.terms ?? []), ...fromFiles.terms]
			// **黙らない。** 辞書が読めないと、社名も顧客名も伏せられないまま送られる。
			// 伏せているつもりで素通りする、いちばん気づけない失敗である。
			this.troubles = [
				...fromFiles.failures.map((one) => `${one.path}: ${one.error}`),
				...fromFiles.problems.map((one) => `${one.path}:${one.line} ${one.value} — ${one.reason}`),
			]
		}

		return {
			terms: this.terms,
			kinds: settings.kinds as readonly PiiKind[] | undefined,
			secretLabels: settings.secretLabels,
		}
	}

	/**
	 * 送る写しを伏せる。
	 *
	 * 伏せるのは送る写しだけで、保存した履歴は利用者が書いたままにする。履歴まで伏せると、
	 * 会話を読み返したときに自分が何を書いたか分からなくなる。
	 */
	async maskForRequest(
		systemPrompt: string,
		messages: AgentMessage[],
	): Promise<{
		systemPrompt: string
		messages: AgentMessage[]
		counts: Partial<Record<PiiKind, number>>
		troubles: readonly string[]
		/** シークレットモードが入っていたか。切のときは呼び出し側も何も出さない。 */
		enabled: boolean
	}> {
		if (!this.enabled) {
			return { systemPrompt, messages, counts: {}, troubles: [], enabled: false }
		}

		const result = maskConversation(systemPrompt, messages, await this.options(), this.vault, this.memo)
		return { ...result, troubles: this.takeDictionaryTroubles(), enabled: true }
	}

	/**
	 * 1 つの文を伏せて、返ってきた文を元へ戻す道筋を添えて返す（`FR-PII-01`）。
	 *
	 * 文の手直しのように、会話とは別に 1 往復するときに実行する。対応表は同じものを使うので、
	 * 会話で割り当てた伏せ字と食い違わない。
	 *
	 * **戻す側は `restore` の設定に従わない。** 返ってきた文は利用者の入力欄へ戻るので、
	 * 伏せ字のままでは読めない。
	 */
	async maskPrompt(text: string): Promise<{ text: string; restore: (text: string) => string }> {
		if (!this.enabled) {
			return { text, restore: (one) => one }
		}

		const plan = planMasking(text, await this.options(), undefined, this.vault)
		return { text: applyPlan(text, plan.edits), restore: (one) => this.vault.restore(one) }
	}

	/**
	 * ツールの引数の伏せ字を元の値へ戻す（`FR-PII-02a`）。
	 *
	 * 戻さない設定なら素通しする（`FR-PII-19`）。文書を清書させるときは、モデルが書いた
	 * 伏せ字をそのまま残したい。
	 */
	unmask(text: string): string {
		return this.enabled && this.restores ? this.vault.restore(text) : text
	}

	/**
	 * 利用者が明示的に戻す（`FR-PII-20`）。
	 *
	 * **設定に従わない。** 戻さない設定で進めて、最後にまとめて戻すのがこの操作の使い道
	 * である。設定に従うと、その使い道でだけ動かないことになる。切り替えを切ったあとでも、
	 * 割り当て済みの伏せ字は戻せる。
	 */
	restoreExplicitly(text: string): string {
		return this.vault.restore(text)
	}

	/**
	 * 辞書で読めなかったもの（`FR-PII-03d` `FR-PII-03g`）。
	 *
	 * 最初の要求のあとに読める。呼び出し側が利用者へ示す。黙って進めると、伏せたつもりで
	 * 素通りする。**一度渡したら空にする。** 要求のたびに同じ警告を出さない。
	 */
	takeDictionaryTroubles(): string[] {
		const taken = this.troubles
		this.troubles = []
		return taken
	}

	/** これまでに伏せた値の数。0 のまま進んでいれば、設定が効いていない。 */
	get maskedCount(): number {
		return this.vault.size
	}
}
