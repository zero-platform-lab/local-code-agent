import * as yaml from "yaml"
import stripBom from "strip-bom"

/**
 * mode 設定ファイルの YAML を読むための前処理とパース。
 *
 * エラーの「表示」は含めない。壊れた YAML は `{ ok: false }` を返すだけで、
 * `vscode.window.showErrorMessage` を出すか黙って握り潰すかは呼び出し側が決める
 * （分割前は判定と UI 通知が同じメソッドに同居していて、パース規則だけを
 * テストすることができなかった）。
 */

/**
 * YAML を壊しがちな不可視文字・体裁文字。
 * - U+00A0: Non-breaking space
 * - U+200B..U+200D: Zero-width spaces and joiners
 * - U+2010..U+2015, U+2212: Various dash characters
 * - U+2018..U+2019: Smart single quotes
 * - U+201C..U+201D: Smart double quotes
 */
const PROBLEMATIC_CHARS_REGEX =
	// eslint-disable-next-line no-misleading-character-class
	/[\u00A0\u200B\u200C\u200D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2018\u2019\u201C\u201D]/g

/**
 * エディタや Web からのコピペで混入する文字を YAML が解釈できる形へ寄せる。
 * 全パターンを 1 パスで置換する。
 */
export function cleanInvisibleCharacters(content: string): string {
	return content.replace(PROBLEMATIC_CHARS_REGEX, (match) => {
		switch (match) {
			case "\u00A0": // Non-breaking space
				return " "
			case "\u200B": // Zero-width space
			case "\u200C": // Zero-width non-joiner
			case "\u200D": // Zero-width joiner
				return ""
			case "\u2018": // Left single quotation mark
			case "\u2019": // Right single quotation mark
				return "'"
			case "\u201C": // Left double quotation mark
			case "\u201D": // Right double quotation mark
				return '"'
			default: // Dash characters (U+2010 through U+2015, U+2212)
				return "-"
		}
	})
}

export type ParseModesYamlResult =
	| { ok: true; value: any }
	| {
			ok: false
			/** YAML パーサのエラーメッセージ。ログ用。 */
			message: string
			/** エラーメッセージから拾った行番号。取れなければ "unknown"。 */
			line: string
	  }

export interface ParseModesYamlOptions {
	/**
	 * YAML として読めなかったときに **元の文字列**を JSON として読み直すか。
	 * `.agentmodes` は歴史的に JSON でも書けたので、その経路だけ true にする。
	 */
	allowJsonFallback: boolean
}

/**
 * BOM と不可視文字を落としてから YAML としてパースする。
 *
 * 成功時の `value` は `null`/`undefined` を `{}` に丸める。ただし JSON フォールバック
 * 経由の値は丸めない（分割前の挙動をそのまま保持している非対称性）。
 */
export function parseModesYaml(content: string, options: ParseModesYamlOptions): ParseModesYamlResult {
	const cleaned = cleanInvisibleCharacters(stripBom(content))

	try {
		return { ok: true, value: yaml.parse(cleaned) ?? {} }
	} catch (yamlError) {
		if (options.allowJsonFallback) {
			try {
				// Try parsing the original content as JSON (not the cleaned content)
				return { ok: true, value: JSON.parse(content) }
			} catch (_jsonError) {
				// JSON also failed — report the original YAML error below.
			}
		}

		const message = yamlError instanceof Error ? yamlError.message : String(yamlError)
		return { ok: false, message, line: message.match(/at line (\d+)/)?.[1] ?? "unknown" }
	}
}
