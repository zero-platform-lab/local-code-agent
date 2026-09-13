import type { AgentMessage, PiiMasking } from "@openai-agent/types"

import { promises as fs } from "fs"

import { defaultDictionaryPath, readDictionaries, resolveDictionaryPath } from "./dictionary"
import { collectTexts, maskConversation, MEMO_LIMIT, PiiVault, sessionVault, type MaskMemo } from "./maskConversation"
import { detectWith, loadBackend, type NerBackend } from "./nerBackend"
import { defaultModelDirectory, describeCheck } from "./nerModel"
import { applyPlan, planMasking, type MaskOptions } from "./maskText"
import type { PiiKind, PiiMatch, PiiTerm } from "./types"

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
/** 辞書のファイルの更新時刻。読めないものは空にする（読めないこと自体は別に知らせる）。 */
async function stamps(paths: readonly string[]): Promise<string[]> {
	return Promise.all(
		paths.map(async (one) => {
			const resolved = resolveDictionaryPath(one)
			if (!resolved) return ""
			try {
				return String((await fs.stat(resolved)).mtimeMs)
			} catch {
				return ""
			}
		}),
	)
}

/**
 * 判定の結果を、本文から引ける形にする。
 *
 * **判定していない本文は、第 2 層の対象外として扱う。** 推測で伏せるより、第 1 層だけで
 * 伏せるほうが害が小さい。判定を先に済ませる作りなので、ここへ来るのは判定の対象から
 * 漏れた本文だけである。
 */
export function lookupOf(found: ReadonlyMap<string, PiiMatch[]>): (text: string) => readonly PiiMatch[] {
	return (text) => found.get(text) ?? []
}

/**
 * 一度に走らせる判定の数。
 *
 * 1 つずつ待つと、初回の長い履歴で本文の数だけ待ち時間が積み上がる。全部同時にすると
 * 記憶が膨らむ。
 */
export const NER_AT_ONCE = 8

export class TaskPiiMasker {
	/**
	 * 対応表。**既定では本製品で 1 つを共有する**（`FR-PII-02b`）。
	 *
	 * 分けると、別のタスクの `{{email-001}}` と同じ形になり、モデルが別人の値を
	 * 書き戻す。試験で切り離したいときだけ渡す。
	 */
	private readonly vault: PiiVault
	private terms: PiiTerm[] | undefined
	private loadedFrom: string | undefined
	private troubles: string[] = []
	private readonly read: () => PiiMasking | undefined
	/** 最後に読めた設定。読めなくなっても、伏せる側を黙って切らないために持つ。 */
	private lastKnown: PiiMasking = {}
	/** 伏せた結果の覚え書き。設定が変わったら捨てる。 */
	private readonly memo: MaskMemo = new Map()
	/** 第 2 層。読むのは 1 度だけで、失敗しても第 1 層は動かし続ける（`FR-PII-23b`）。 */
	private backend: NerBackend | undefined
	private backendTried = false
	/** 本文ごとの第 2 層の結果。同じ本文を毎回判定し直さない。 */
	private nerMemo = new Map<string, PiiMatch[]>()
	/** 前の要求で第 2 層が使えたか。変わったら伏せた結果の記憶を捨てる。 */
	private lastLayerTwo: boolean | undefined

	/**
	 * **設定は要求のたびに読み直す。** 会話の途中で切り替えられるボタンを画面に置いた以上
	 * （`FR-PII-01b`）、抱え込むと押しても効かない。利用者は伏せたつもりで送ってしまう。
	 *
	 * 対応表だけは持ち越す。番号が振り直されると、前の応答の伏せ字が別の値を指す。
	 */
	constructor(read: (() => PiiMasking | undefined) | PiiMasking, vault: PiiVault = sessionVault()) {
		this.vault = vault
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
		// **辞書のファイルの更新時刻も鍵に含める。** 右クリックで語を足しても設定は変わらない
		// ので、設定だけを見ていると、足した語がその会話では二度と効かない。利用者には
		// 「足しました」と出ているのに伏せられない。
		const key = JSON.stringify([
			settings.dictionaryPaths ?? [],
			settings.terms ?? [],
			settings.kinds ?? [],
			settings.secretLabels ?? [],
			// 第 2 層の設定も鍵に含める。含めないと、切り替えても覚えていた結果を返す。
			settings.properNouns ?? {},
			// 既定の辞書も見る。右クリックで足す先がここになることがある。
			await stamps([...(settings.dictionaryPaths ?? []), defaultDictionaryPath()]),
		])
		if (this.terms === undefined || this.loadedFrom !== key) {
			this.loadedFrom = key
			// 設定が変われば、覚えていた結果はもう当てにならない。
			this.memo.clear()
			// **文字数も戻す。** 戻さないと、空の記憶が上限を超えている扱いになり、
			// 次に入れた 1 件をすぐ捨てる。以後ずっと何も覚えられない。
			this.memo.bytes = 0
			// 第 2 層も読み直す。置き場所を変えても効かない、という取り違えを避ける。
			this.nerMemo = new Map()
			this.backend = undefined
			this.backendTried = false
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
	 * 第 2 層の判定を先に済ませ、本文から引ける形にする（`FR-PII-21`）。
	 *
	 * **なぜ先に済ませるのか。** 判定は非同期だが、伏せる処理は同期である。渡す前に
	 * 全部の本文を判定しておき、あとは引くだけにする。
	 *
	 * **読めなくても止めない（`FR-PII-23b`）。** モデルを置いていない利用者のほうが多い。
	 * 第 2 層が動かないだけで、第 1 層はそのまま動かす。ただし**黙らない**
	 * （`FR-PII-22a`）。画面の見た目が変わらないので、出さないと取り違えに気づけない。
	 */
	/**
	 * 第 2 層の判定を、会話の外からも使えるようにする（`FR-PII-11`）。
	 *
	 * 右クリックのファイルの置き換えで使う。ここを通さないと、会話では伏せる名前が
	 * ファイルには残り、**利用者は綺麗になったと思って渡す**。
	 */
	async properNounsFor(texts: readonly string[]): Promise<MaskOptions["properNouns"]> {
		return this.properNouns(texts)
	}

	private async properNouns(texts: readonly string[]): Promise<MaskOptions["properNouns"]> {
		const settings = this.settings.properNouns
		if (settings?.enabled !== true) return undefined

		// `resolveDictionaryPath` は `~` を開き、空欄を落とす。落ちたら既定の場所を見る。
		const directory = (settings.modelPath && resolveDictionaryPath(settings.modelPath)) || defaultModelDirectory()

		// **先に上限を見る。** 判定したあとに捨てると、いま判定したぶんまで消える。
		this.capNerMemo()

		if (!this.backendTried) {
			this.backendTried = true

			// **例外で要求全体を殺さない（`FR-PII-23b`）。** モデルの読み込みは native を
			// 伴うので、環境によっては投げる。投げたまま通すと、第 1 層も動かないまま
			// 会話が失敗する。第 2 層が動かないだけにして、その旨を出す。
			try {
				const loaded = await loadBackend(directory)
				this.backend = loaded.backend
				if (!loaded.backend) this.trouble(directory, describeCheck(loaded.check))
			} catch (error) {
				this.trouble(directory, error instanceof Error ? error.message : String(error))
			}
		}

		const backend = this.backend
		if (!backend) {
			this.noteLayerTwo(false)
			return undefined
		}

		const options = { minScore: settings.minScore, entities: settings.entities }
		const pending = texts.filter((text) => !this.nerMemo.has(text))

		// **まとめて走らせる。** 1 つずつ待つと、初回の長い履歴で本文の数だけ待ち時間が
		// 積み上がる。数を抑えるのは、全部同時に投げると記憶が膨らむためである。
		for (let at = 0; at < pending.length; at += NER_AT_ONCE) {
			const batch = pending.slice(at, at + NER_AT_ONCE)
			// **`allSettled` にする。** `all` だと 1 件の失敗で、同じまとまりの中で
			// 済んでいたぶんまで捨てる。
			const found = await Promise.allSettled(batch.map((text) => detectWith(backend, text, options)))
			found.forEach((one, index) => {
				if (one.status === "fulfilled") this.nerMemo.set(batch[index], one.value)
			})

			const failed = found.find((one) => one.status === "rejected")
			if (failed) {
				// **次の要求で読み直す。** 一度の不調で、この会話の間ずっと第 2 層を
				// 止めない。済んだぶんは上で記憶へ入れてある。
				const error = (failed as PromiseRejectedResult).reason
				this.backend = undefined
				this.backendTried = false
				this.trouble(directory, error instanceof Error ? error.message : String(error))
				break
			}
		}

		// **判定が終わってから記録する。** 途中で失敗すれば `this.backend` は空になる。
		// 始める前に「使える」と記録すると、失敗した回を成功として覚えてしまう。
		this.noteLayerTwo(Boolean(this.backend))
		return lookupOf(this.nerMemo)
	}

	/**
	 * 第 2 層が効いたかどうかが前の要求と変わったら、伏せた結果の記憶を捨てる。
	 *
	 * 記憶の鍵は本文だけなので、第 2 層が効かなかったときの結果がそのまま残る。あとで
	 * モデルが使えるようになっても、覚えていた第 1 層だけの結果を返し続け、**画面には
	 * 何も出ないまま名前が素通りする**。
	 */
	private noteLayerTwo(worked: boolean): void {
		if (this.lastLayerTwo === worked) return

		this.lastLayerTwo = worked
		this.memo.clear()
		this.memo.bytes = 0
	}

	/** 第 2 層が動かなかったことを伝える（`FR-PII-22a`）。黙ると取り違えに気づけない。 */
	private trouble(directory: string, why: string | undefined): void {
		this.troubles = [...this.troubles, `固有名詞の検出を実行できない（${directory}）: ${why}`]
	}

	/**
	 * 判定の記憶が膨らみ続けないようにする。
	 *
	 * 鍵は本文そのもので、数十 KB のツールの出力がそのまま残る。件数ではなく文字数で
	 * 抑えるのは、`MaskMemo` と同じ理由である。
	 */
	private capNerMemo(): void {
		let held = 0
		for (const text of this.nerMemo.keys()) held += text.length
		if (held > MEMO_LIMIT) this.nerMemo = new Map()
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

		const options = await this.options()
		const properNouns = await this.properNouns(collectTexts(systemPrompt, messages))

		const result = maskConversation(systemPrompt, messages, { ...options, properNouns }, this.vault, this.memo)
		return { ...result, troubles: this.takeDictionaryTroubles(), enabled: true }
	}

	/**
	 * 1 つの文を伏せて、返ってきた文を元へ戻す道筋を添えて返す（`FR-PII-01`）。
	 *
	 * 文の手直しのように、会話とは別に 1 往復するときに実行する。対応表は同じものを使うので、
	 * 会話で割り当てた伏せ字と食い違わない。
	 *
	 * **戻す側は設定に従わない。** 返ってきた文は利用者の入力欄へ戻るので、
	 * 伏せ字のままでは読めない。
	 */
	async maskPrompt(text: string): Promise<{ text: string; restore: (text: string) => string }> {
		if (!this.enabled) {
			return { text, restore: (one) => one }
		}

		// **ここにも第 2 層を通す。** 通さないと、文の手直しの経路だけが素通りする。
		// 送る呼び出しは 3 つあり、1 つでも抜けると伏せているつもりで送られる。
		const options = await this.options()
		const properNouns = await this.properNouns([text])

		const plan = planMasking(text, { ...options, properNouns }, undefined, this.vault)
		return { text: applyPlan(text, plan.edits), restore: (one) => this.vault.restore(one) }
	}

	/**
	 * ツールの引数の伏せ字を元の値へ戻す（`FR-PII-02a`）。
	 *
	 * 戻さない設定なら素通しする（`FR-PII-19`）。文書を清書させるときは、モデルが書いた
	 * 伏せ字をそのまま残したい。
	 */
	unmask(text: string): string {
		// **いま入っているかで判断しない。** 切り替えを切ったあとでも、モデルの文脈には
		// 割り当て済みの伏せ字が残っている。切ったことを理由に戻さないと、`{{email-001}}`
		// という文字列がそのままファイルへ書かれる。戻すのは割り当てたものだけなので
		// （`FR-PII-08a`）、入っていなくても安全である。
		return this.restores ? this.vault.restore(text) : text
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

	/**
	 * 番号を振る係。ファイルの置き換えでも同じものを使う。
	 *
	 * 分けると、同じ形の伏せ字が別の値を指すことになる。
	 */
	get allocator(): PiiVault {
		return this.vault
	}

	/** これまでに伏せた値の数。0 のまま進んでいれば、設定が効いていない。 */
	get maskedCount(): number {
		return this.vault.size
	}
}
