// npx vitest run core/config/__tests__/modeYaml.nonError.spec.ts
//
// yaml.parse が「Error でない値」を throw する経路を実際に踏ませるための専用ファイル。
// 本体 spec (modeYaml.spec.ts) は実物の yaml パーサを使うため、ここだけ yaml をモックする
// （vi.mock はファイル単位でホイストされるので、実 YAML を読むテストと同居できない）。

vi.mock("yaml", () => ({
	// 文字列（非 Error）を throw する。これで catch 節の
	// `yamlError instanceof Error ? yamlError.message : String(yamlError)` の
	// 非 Error 側 = String(yamlError) を実際に通す。
	parse: vi.fn(() => {
		throw "not-an-error-object"
	}),
}))

import { parseModesYaml } from "../modeYaml"

describe("parseModesYaml (yaml.parse が非 Error を throw する場合)", () => {
	it("String(yamlError) でメッセージ化し、行番号は unknown になる", () => {
		const result = parseModesYaml("anything", { allowJsonFallback: false })

		expect(result.ok).toBe(false)
		// String("not-an-error-object") がそのまま message になる。
		expect(result.ok === false && result.message).toBe("not-an-error-object")
		// "at line N" を含まないので line は "unknown" に落ちる（?? "unknown" の右側）。
		expect(result.ok === false && result.line).toBe("unknown")
	})

	it("JSON フォールバックが有効でも、内容が JSON でなければ非 Error メッセージを返す", () => {
		// content 自体は JSON.parse も失敗するので、yaml 側の非 Error メッセージが報告される。
		const result = parseModesYaml("plain text, not json", { allowJsonFallback: true })

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.message).toBe("not-an-error-object")
		expect(result.ok === false && result.line).toBe("unknown")
	})
})
