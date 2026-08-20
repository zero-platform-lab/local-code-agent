import { DEFAULT_MAX_DIAGNOSTIC_MESSAGES } from "@openai-agent/types"

// 既定値は拡張ホストと共有する唯一の出所から取る（ここで再定義すると 3 つ目のコピーになる）。
export { DEFAULT_MAX_DIAGNOSTIC_MESSAGES }

/**
 * 診断メッセージ上限（`maxDiagnosticMessages`）のスライダー ↔ 保存値の対応。
 *
 * 保存値は「0 以下 = 無制限」というセンチネル方式で、スライダーは 1〜100 の連続値。
 * 両者の変換が JSX に 4 箇所インラインで複製されていた（値・aria-valuenow・
 * aria-valuetext・表示ラベル）ので、規則を 1 箇所に集約したもの。
 */

/** 保存側で「無制限」を表す値。 */
export const UNLIMITED_STORED_VALUE = -1

/** スライダーの下限。 */
export const MIN_SLIDER_VALUE = 1

/** スライダーの上限。この位置が「無制限」を意味する。 */
export const MAX_SLIDER_VALUE = 100

/**
 * 保存値をスライダー位置に変換する。
 *
 * 0 以下（無制限）は上限へ、未設定は既定値へ寄せる。
 */
export function toSliderValue(stored: number | undefined): number {
	if (stored !== undefined && stored <= 0) {
		return MAX_SLIDER_VALUE
	}

	return stored ?? DEFAULT_MAX_DIAGNOSTIC_MESSAGES
}

/**
 * スライダー位置を保存値に変換する。
 *
 * 上限まで動かしたら「無制限」として負のセンチネルで保存する。
 */
export function fromSliderValue(sliderValue: number): number {
	return sliderValue === MAX_SLIDER_VALUE ? UNLIMITED_STORED_VALUE : sliderValue
}

/**
 * 表示上「無制限」として扱うか。
 *
 * センチネル（0 以下）に加えて、ちょうど上限 100 が保存されている場合も無制限とみなす
 * （スライダーを上限まで動かした直後は -1 で保存されるが、外部から 100 が入ることもあるため）。
 */
export function isUnlimited(stored: number | undefined): boolean {
	return (stored !== undefined && stored <= 0) || stored === MAX_SLIDER_VALUE
}
