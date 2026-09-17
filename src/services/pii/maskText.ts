import {
	DEFAULT_SECRET_LABELS,
	detectAddresses,
	detectAuthorization,
	detectCards,
	detectEmails,
	detectHosts,
	detectIps,
	detectKnownSecrets,
	detectMyNumbers,
	detectLabelledSecrets,
	detectPhones,
	detectTerms,
	detectZipCodes,
} from "./detectors"
import { dropOverlapping } from "./nerDetector"
import { PII_KINDS, type PiiKind, type PiiMatch, type PiiTerm } from "./types"

/**
 * 伏せ字の割り当てと、元の値への復元。
 *
 * **目的。** `detectors` が見つけた位置を、`{{種類-番号}}` の形へ置き換える
 * （`FR-PII-08`）。置き換えは可逆とし、応答をファイルへ書き戻す前に元へ戻せるようにする
 * （`FR-PII-02` `FR-PII-02a`）。
 *
 * **仕組み。** 3 段に分かれている。
 *
 * 1. `findPii` — 種類ごとの検出を集め、重なりを解く
 * 2. `planMasking` — どこを何へ置き換えるかを決める。本文は書き換えない
 * 3. `applyPlan` / `maskText` — 計画を本文へ適用する
 *
 * 計画と適用を分けてあるのは、右クリックからの置き換えが本文ではなく編集の一覧を要る
 * ためである（`FR-PII-11c`）。1 つの `WorkspaceEdit` にまとめれば、取り消しの操作 1 回で
 * 元へ戻る。
 *
 * **同じ値には同じ伏せ字を割り当てる**（`FR-PII-02`）。別の番号を割り当てると、モデルは
 * 別人だと読む。**書き方が違えば別の番号にする。** `ACME` と `acme` を 1 つにまとめると、
 * 戻すときにどちらの書き方だったか分からない。復元の確かさを優先する。
 *
 * **戻すのは、その回に割り当てた伏せ字だけ**にする（`FR-PII-08a`）。元から
 * `{{person-001}}` と書かれていたファイルを読むと、対応表に無い伏せ字が本文に現れる。
 */

export type MaskOptions = {
	/** 利用者が挙げた語（`FR-PII-03`）。 */
	terms?: readonly PiiTerm[]
	/** 伏せる種類。省略すると全部を伏せる（`FR-PII-07`）。 */
	kinds?: readonly PiiKind[]
	/** 鍵のラベルに足す語（`FR-PII-10g`）。既定の一覧へ重ねる。 */
	secretLabels?: readonly string[]
	/**
	 * 第 2 層が見つけた固有名詞（`FR-PII-21`）。本文から引ける形で渡す。
	 *
	 * **なぜ関数で渡すのか。** 第 2 層の判定は非同期だが、ここから下は同期である。
	 * 呼ぶ側が先に判定を済ませ、その結果を引けるようにして渡す。
	 *
	 * 渡されなければ第 2 層は無いものとして扱う。第 1 層はそのまま動く。
	 */
	properNouns?: (text: string) => readonly PiiMatch[]
}

export type MaskResult = {
	text: string
	/** 種類ごとの件数（`FR-PII-01c`）。1 件も無い種類は持たない。 */
	counts: Partial<Record<PiiKind, number>>
	/**
	 * 伏せ字 → 元の値（`FR-PII-02`）。
	 *
	 * 右クリックからの置き換えでは使わない（`FR-PII-11d`）。持てば、その対応表が伏せた値を
	 * 抱えることになり、伏せた意味が無くなる。
	 */
	table: ReadonlyMap<string, string>
}

/**
 * 伏せ字の形。戻すときの照合にも使う。
 *
 * 番号は 3 桁で埋めるが、1,000 件を超えると 4 桁になるので下限だけを決める。種類は
 * 英字だけなので、`{{` と `}}` の間にそれ以外が入っていれば伏せ字ではない。
 */
const PLACEHOLDER = /\{\{([a-z]+)-(\d{3,})\}\}/g

function placeholderFor(kind: PiiKind, index: number): string {
	return `{{${kind}-${String(index).padStart(3, "0")}}}`
}

/**
 * 伏せ字を割り当てる係。
 *
 * **番号を持つのは呼び出し側にする。** `planMasking` が毎回 1 から振ると、要求ごとに
 * 同じ番号が別の値へ結び付く。前の応答で `{{email-001}}` と書いたモデルに、次の要求で
 * 別人を指す `{{email-001}}` を見せることになる。
 */
export type PlaceholderAllocator = {
	/** 同じ種類と値には同じ伏せ字を返す。初めてなら新しい番号を振る。 */
	assign: (kind: PiiKind, value: string) => string
	/** 伏せ字 → 元の値。戻すときに使う。 */
	readonly table: ReadonlyMap<string, string>
}

type MutablePlaceholderAllocator = PlaceholderAllocator & {
	/** 割り当てを捨てる。番号は再利用しない。 */
	remove: (placeholder: string) => boolean
	/** 保存済みの伏せ字を、空いていれば同じ番号のまま取り込む。 */
	reserve: (kind: PiiKind, value: string, placeholder: string) => string
}

/** 1 回の置き換えだけで使う割り当て係。要求をまたがない用途に使う。 */
export function createAllocator(): MutablePlaceholderAllocator {
	const table = new Map<string, string>()
	const assigned = new Map<string, string>()
	const assignmentKeys = new Map<string, string>()
	const next = new Map<PiiKind, number>()

	return {
		table,
		assign(kind, value) {
			const key = `${kind} ${value}`
			const existing = assigned.get(key)
			if (existing !== undefined) return existing

			const index = (next.get(kind) ?? 0) + 1
			next.set(kind, index)
			const placeholder = placeholderFor(kind, index)
			assigned.set(key, placeholder)
			assignmentKeys.set(placeholder, key)
			table.set(placeholder, value)
			return placeholder
		},
		reserve(kind, value, placeholder) {
			const key = `${kind} ${value}`
			const existing = assigned.get(key)
			if (existing !== undefined) return existing
			const occupied = table.get(placeholder)
			if (occupied !== undefined) return this.assign(kind, value)

			const match = /^\{\{[a-z]+-(\d{3,})\}\}$/.exec(placeholder)
			if (!match) return this.assign(kind, value)
			next.set(kind, Math.max(next.get(kind) ?? 0, Number(match[1])))
			assigned.set(key, placeholder)
			assignmentKeys.set(placeholder, key)
			table.set(placeholder, value)
			return placeholder
		},
		remove(placeholder) {
			if (!table.delete(placeholder)) return false

			const key = assignmentKeys.get(placeholder)
			if (key !== undefined) assigned.delete(key)
			assignmentKeys.delete(placeholder)
			return true
		},
	}
}

/**
 * 重なりを解く。
 *
 * 始まりが早いものを優先し、同じ始まりなら長いものを採る。クレジットカード番号の中に
 * 電話番号の形が含まれることがあるが、長いほうを採れば分断されない。
 */
export function resolveOverlaps(matches: readonly PiiMatch[]): PiiMatch[] {
	// 長いものから採る。始まりが早いだけの短いものを先に採ると、後ろへはみ出した分が
	// 素のまま残る（`Contact taro@corp.example` の `@corp.example` など）。
	const sorted = [...matches].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)

	const kept: PiiMatch[] = []
	for (const match of sorted) {
		// 既に採ったものと少しでも重なるなら飛ばす。伏せ字の中へ別の伏せ字は置けない。
		if (kept.some((one) => match.start < one.end && one.start < match.end)) continue
		kept.push(match)
	}

	// 置き換えは前から順に当てるので、位置で並べ直す。
	return kept.sort((a, b) => a.start - b.start)
}

/** 本文から伏せる対象を見つける。重なりは解いてある。 */
export function findPii(text: string, options: MaskOptions = {}): PiiMatch[] {
	const kinds = new Set<PiiKind>(options.kinds ?? PII_KINDS)
	const labels = [...DEFAULT_SECRET_LABELS, ...(options.secretLabels ?? [])]

	const found: PiiMatch[] = []
	const wants = (kind: PiiKind) => kinds.has(kind)

	if (options.terms && options.terms.length > 0) {
		found.push(...detectTerms(text, options.terms).filter((match) => wants(match.kind)))
	}
	if (wants("secret")) {
		found.push(...detectKnownSecrets(text), ...detectLabelledSecrets(text, labels), ...detectAuthorization(text))
	}
	if (wants("email")) found.push(...detectEmails(text))
	if (wants("host")) found.push(...detectHosts(text))
	if (wants("ip")) found.push(...detectIps(text))
	if (wants("card")) found.push(...detectCards(text))
	if (wants("mynumber")) found.push(...detectMyNumbers(text))
	if (wants("phone")) found.push(...detectPhones(text))
	if (wants("zip")) found.push(...detectZipCodes(text))
	if (wants("address")) found.push(...detectAddresses(text))

	// **第 1 層を優先する（`FR-PII-21f`）。** 第 1 層は形で判定していて確実なので、
	// 重なったときに推定側を採る理由が無い。種類の切り替えは第 2 層にも効かせる。
	if (options.properNouns) {
		const guessed = options.properNouns(text).filter((match) => wants(match.kind))
		found.push(...dropOverlapping(guessed, found))
	}

	return resolveOverlaps(found)
}

/** 1 か所の置き換え。範囲と、そこへ入れる伏せ字。 */
export type MaskEdit = {
	start: number
	end: number
	placeholder: string
}

export type MaskPlan = {
	edits: MaskEdit[]
	counts: Partial<Record<PiiKind, number>>
	table: ReadonlyMap<string, string>
}

/**
 * どこを何へ置き換えるかを決める。本文は書き換えない。
 *
 * **範囲の中に収まる箇所だけ**を対象にする（`FR-PII-11a`）。検出は本文全体で
 * 行う。範囲だけを切り出して渡すと、範囲の外から続く住所や鍵の並びが途中で切れる。
 */
export function planMasking(
	text: string,
	options: MaskOptions = {},
	range?: { start: number; end: number },
	/** 要求をまたいで番号をそろえたい場合に渡す。省略すると 1 回限りの割り当てになる。 */
	allocator?: PlaceholderAllocator,
): MaskPlan {
	const matches = findPii(text, options).filter(
		(match) => range === undefined || (match.start >= range.start && match.end <= range.end),
	)

	const own = allocator ?? createAllocator()
	const counts: Partial<Record<PiiKind, number>> = {}

	const edits: MaskEdit[] = []
	for (const match of matches) {
		counts[match.kind] = (counts[match.kind] ?? 0) + 1
		edits.push({ start: match.start, end: match.end, placeholder: own.assign(match.kind, match.value) })
	}

	return { edits, counts, table: own.table }
}

/** 計画を本文へ適用する。`edits` は前から順に並んでいて重ならない。 */
export function applyPlan(text: string, edits: readonly MaskEdit[]): string {
	let out = ""
	let cursor = 0
	for (const edit of edits) {
		out += text.slice(cursor, edit.start) + edit.placeholder
		cursor = edit.end
	}
	return out + text.slice(cursor)
}

export function maskText(text: string, options: MaskOptions = {}): MaskResult {
	const plan = planMasking(text, options)

	return { text: applyPlan(text, plan.edits), counts: plan.counts, table: plan.table }
}

/**
 * 伏せ字を元の値へ戻す（`FR-PII-02a`）。
 *
 * **戻すのは、その回に割り当てた伏せ字だけ**にする（`FR-PII-08a`）。元から
 * `{{person-001}}` と書かれていたファイルを読むと、対応表に無い伏せ字が本文に現れる。
 * それを別の値へ置き換えると、書いていないものが混ざる。
 */
export function unmaskText(text: string, table: ReadonlyMap<string, string>): string {
	if (table.size === 0) return text

	return text.replace(PLACEHOLDER, (whole) => table.get(whole) ?? whole)
}

/** 件数の合計。0 件のまま進んでいれば、設定が効いていないことに気づける（`FR-PII-01c`）。 */
export function totalCount(counts: Partial<Record<PiiKind, number>>): number {
	// 値を入れるのは `maskText` だけで、未定義は入らない。分けて扱わない。
	return Object.values(counts as Record<string, number>).reduce((sum, value) => sum + value, 0)
}
