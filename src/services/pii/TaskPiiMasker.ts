import type { AgentMessage, PiiMasking } from "@openai-agent/types"

import { readDictionaries } from "./dictionary"
import { maskConversation, PiiVault } from "./maskConversation"
import type { MaskOptions } from "./maskText"
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
	private troubles: string[] = []
	private readonly settings: PiiMasking

	constructor(settings: PiiMasking) {
		this.settings = settings
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
		if (this.terms === undefined) {
			const fromFiles = await readDictionaries(this.settings.dictionaryPaths ?? [])
			this.terms = [...(this.settings.terms ?? []), ...fromFiles.terms]
			// **黙らない。** 辞書が読めないと、社名も顧客名も伏せられないまま送られる。
			// 伏せているつもりで素通りする、いちばん気づけない失敗である。
			this.troubles = [
				...fromFiles.failures.map((one) => `${one.path}: ${one.error}`),
				...fromFiles.problems.map((one) => `${one.path}:${one.line} ${one.value} — ${one.reason}`),
			]
		}

		return {
			terms: this.terms,
			kinds: this.settings.kinds as readonly PiiKind[] | undefined,
			secretLabels: this.settings.secretLabels,
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
	}> {
		if (!this.enabled) {
			return { systemPrompt, messages, counts: {}, troubles: [] }
		}

		const result = maskConversation(systemPrompt, messages, await this.options(), this.vault)
		return { ...result, troubles: this.takeDictionaryTroubles() }
	}

	/** 伏せ字を元の値へ戻す（`FR-PII-02a`）。戻さない設定なら素通しする。 */
	unmask(text: string): string {
		return this.enabled && this.restores ? this.vault.restore(text) : text
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
