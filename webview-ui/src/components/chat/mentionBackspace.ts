import { mentionRegex } from "@agent/context-mentions"
import { removeMention } from "@src/utils/context-mentions"

/**
 * メンション直後で Backspace が押されたときに「何をするか」を決める純関数。
 *
 * `handleKeyDown` の中で 44 行あり、判断と 5 つの setter 呼び出し・DOM 操作
 * (`setSelectionRange`) が混ざっていたため、正規表現による境界判定を確かめるには
 * キーイベントを合成するしかなかった（直接のテストは 0 件）。
 *
 * ここは DOM にも React にも触らない。IME 中かどうかの判定は呼び出し側に残している
 * （この関数は「Backspace かつ変換中でない」と判った後にだけ呼ばれる）。
 */

/** 空白と見なす文字。 */
function isWhitespaceChar(char: string | undefined): boolean {
	// NOTE: "\r\n" は 1 文字の添字アクセスでは決して一致しない（分割前からの条件をそのまま保持）。
	return char === " " || char === "\n" || char === "\r\n"
}

export type MentionBackspaceAction =
	/**
	 * 「@mention␣」の空白の上で押された。空白を消す代わりにメンション末尾へ寄せる。
	 * `moveCaret` が true のときだけ既定動作を止めてキャレットを動かす
	 * （メンションの後ろに別の語が続く場合。空白が続くなら普通に消させる）。
	 */
	| { kind: "collapse-space-after-mention"; newCursorPosition: number; moveCaret: boolean }
	/**
	 * 直前に上の状態を通っている。今度はメンション本体を消す。
	 * `removed` が null なら消せるものが無かった（それでもフラグとメニューは畳む）。
	 */
	| { kind: "remove-mention"; removed: { newText: string; newCursorPosition: number } | null }
	/** メンションと無関係な Backspace。覚えていた状態を捨てるだけ。 */
	| { kind: "forget" }

export interface MentionBackspaceInput {
	inputValue: string
	cursorPosition: number
	/** 直前の Backspace がメンション直後の空白を畳んだか。 */
	justDeletedSpaceAfterMention: boolean
}

export function resolveMentionBackspace(input: MentionBackspaceInput): MentionBackspaceAction {
	const { inputValue, cursorPosition, justDeletedSpaceAfterMention } = input

	const charBeforeCursor = inputValue[cursorPosition - 1]
	// NOTE: 「カーソルの次の文字」なら [cursorPosition] のはずだが、分割前から +1 を見ている。
	// 挙動を変えないためそのまま。
	const charAfterCursor = inputValue[cursorPosition + 1]

	const beforeIsWhitespace = isWhitespaceChar(charBeforeCursor)
	const afterIsWhitespace = isWhitespaceChar(charAfterCursor)

	// カーソル直前の空白が、メンションの直後にあるか。"$" で末尾一致を強制する。
	const isSpaceRightAfterMention =
		beforeIsWhitespace &&
		inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$")) !== null

	if (isSpaceRightAfterMention) {
		return {
			kind: "collapse-space-after-mention",
			newCursorPosition: cursorPosition - 1,
			// メンションの後ろが空白なら既定の削除に任せ、そうでなければ寄せるだけにする。
			moveCaret: !afterIsWhitespace,
		}
	}

	if (justDeletedSpaceAfterMention) {
		const { newText, newPosition } = removeMention(inputValue, cursorPosition)

		return {
			kind: "remove-mention",
			removed: newText !== inputValue ? { newText, newCursorPosition: newPosition } : null,
		}
	}

	return { kind: "forget" }
}
