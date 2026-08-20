import { isSecretStateKey } from "@openai-agent/types"

/**
 * 「この書き込みを未保存の変更として数えるか」の判定。
 *
 * 設定画面は下書き（cachedState）を持ち、変更があると保存ボタンが有効になる。
 * ところが各セクションは**マウント時に自動で値を書き戻す**ことがあり、素直に
 * 「書き込み = 変更」とすると画面を開いただけで未保存扱いになってしまう。
 * その切り分け規則がここ。
 *
 * 元は `SettingsView.setApiConfigurationField` の中に埋まっていて、規則を検証したい
 * spec が本文をコメントに書き写して `expect(true).toBe(true)` を置くしかない状態だった。
 */

/**
 * 2 つの値が意味的に等しいか。
 *
 * `null` と `undefined` は同じ「未設定」とみなす。オブジェクトは JSON 表現で比較するので、
 * **キーの順序が違うと別物と判定される**（自動同期の no-op 検出という用途では、
 * 取りこぼしても「変更あり」に倒れるだけなので安全側）。
 *
 * 注意: `""` と `undefined` はここでは**別物**として扱う。空値をまとめて潰してよいかは
 * フィールドごとの判断なので {@link shouldMarkDirty} 側で決める。
 */
export function areValuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a == null && b == null) return true
	if (typeof a !== typeof b) return false
	if (typeof a === "object" && typeof b === "object") {
		return JSON.stringify(a) === JSON.stringify(b)
	}
	return false
}

/** 「未設定」とみなす値。 */
function isBlank(value: unknown): boolean {
	return value === undefined || value === "" || value === null
}

/**
 * そのフィールドで `""` と `undefined` を区別しなければならないか。
 *
 * secret は**保存経路と利用経路の両方**で空値の種類が意味を持つため、まとめて潰せない:
 *
 * - `ContextProxy.storeSecret` は `value === undefined` なら SecretStorage から
 *   **削除**し、`""` なら**空文字を保存**する（`src/core/config/ContextProxy.ts`）。
 * - `OpenAiHandler` は `openAiApiKey ?? "not-provided"` と `??` で受けるため、
 *   `""` はそのまま空のキーとして送られ、`undefined` だけが既定値に化ける
 *   （`src/api/providers/openai.ts`）。他のフィールドは `||` で受けており両者は同じ。
 *
 * つまり secret では「未設定に戻す」と「空にする」が別の操作なので、その往復を
 * 「変化なし」と丸めるとユーザーの実変更が保存ボタンに現れなくなる。
 *
 * 判定には `ContextProxy` が secret 経路へ振り分けるのと**同じ述語**を使う。
 * 秘匿キーが増えても、ここを書き直さずに追従させるため。
 */
function distinguishesBlankValues(field: string): boolean {
	return isSecretStateKey(field)
}

/**
 * 設定フィールドへの書き込みを未保存の変更として数えるべきか。
 *
 * @param field 書き込み先のフィールド名（secret かどうかの判定に使う）
 * @param previousValue 書き込み前の値
 * @param nextValue 書き込む値
 * @param isUserAction ユーザー操作由来か（false = コンポーネントの自動同期）
 *
 * ユーザー操作は常に変更として数える。自動同期のときだけ例外を認める:
 * - **初期同期**: 未設定から実値が入った（画面を開いた時点の埋め込み）
 * - **空値どうしの往復**: `undefined` ⇄ `""` など。ただし secret は除く
 *   （{@link distinguishesBlankValues} 参照）
 * - **無変化の同期**: 意味的に同じ値が書き戻された
 */
export function shouldMarkDirty(
	field: string,
	previousValue: unknown,
	nextValue: unknown,
	isUserAction: boolean,
): boolean {
	if (isUserAction) {
		return true
	}

	if (isBlank(previousValue)) {
		// Only skip change detection for automatic initialization (not user actions).
		// This prevents the dirty state when the component initializes and auto-syncs values.
		if (!isBlank(nextValue)) {
			return false
		}

		// 空値どうしの往復。secret 以外は種類の違い（undefined / null / ""）を無視する。
		if (!distinguishesBlankValues(field)) {
			return false
		}
	}

	// Also skip if it's an automatic sync with semantically equal values.
	return !areValuesEqual(previousValue, nextValue)
}
