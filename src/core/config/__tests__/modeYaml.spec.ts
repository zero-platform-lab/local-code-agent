// npx vitest run core/config/__tests__/modeYaml.spec.ts

import { cleanInvisibleCharacters, parseModesYaml } from "../modeYaml"

describe("cleanInvisibleCharacters", () => {
	it("turns a non-breaking space into a plain space", () => {
		expect(cleanInvisibleCharacters("slug: code")).toBe("slug: code")
	})

	it("drops zero-width space / non-joiner / joiner", () => {
		expect(cleanInvisibleCharacters("sl​u‌g‍: code")).toBe("slug: code")
	})

	it("normalizes smart single quotes", () => {
		expect(cleanInvisibleCharacters("name: ‘code’")).toBe("name: 'code'")
	})

	it("normalizes smart double quotes", () => {
		expect(cleanInvisibleCharacters("name: “code”")).toBe('name: "code"')
	})

	it("normalizes every dash variant to a hyphen", () => {
		const dashes = "‐‑‒–—―−"
		expect(cleanInvisibleCharacters(dashes)).toBe("-".repeat(dashes.length))
	})

	it("leaves ordinary content untouched", () => {
		const plain = "customModes:\n  - slug: code\n    name: Code 🚀\n"
		expect(cleanInvisibleCharacters(plain)).toBe(plain)
	})
})

describe("parseModesYaml", () => {
	const yamlOnly = { allowJsonFallback: false }
	const withJson = { allowJsonFallback: true }

	it("parses valid YAML", () => {
		expect(parseModesYaml("customModes:\n  - slug: code\n", yamlOnly)).toEqual({
			ok: true,
			value: { customModes: [{ slug: "code" }] },
		})
	})

	it("strips a BOM before parsing", () => {
		expect(parseModesYaml("﻿customModes: []", yamlOnly)).toEqual({ ok: true, value: { customModes: [] } })
	})

	it("cleans invisible characters before parsing", () => {
		const result = parseModesYaml("customModes:\n  - slug: code\n", yamlOnly)

		expect(result).toEqual({ ok: true, value: { customModes: [{ slug: "code" }] } })
	})

	it("normalizes an empty document to an empty object", () => {
		expect(parseModesYaml("", yamlOnly)).toEqual({ ok: true, value: {} })
	})

	it("reports the failing line for broken YAML", () => {
		const result = parseModesYaml("customModes:\n  - slug: [unclosed\n", yamlOnly)

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.line).not.toBe("unknown")
		expect(result.ok === false && result.message).toBeTruthy()
	})

	it("reports the YAML error when the content is neither valid YAML nor valid JSON", () => {
		const result = parseModesYaml("\ta: 1", withJson)

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.message).toContain("Tabs are not allowed")
	})

	it("parses the ORIGINAL content as JSON when YAML fails and the fallback is on", () => {
		// キー重複は JSON では合法（後勝ち）だが YAML ではエラーになる。
		const result = parseModesYaml('{"customModes":[],"customModes":[{"slug":"code"}]}', withJson)

		expect(result).toEqual({ ok: true, value: { customModes: [{ slug: "code" }] } })
	})

	it("does not accept the same duplicate-key content without the fallback", () => {
		expect(parseModesYaml('{"customModes":[],"customModes":[{"slug":"code"}]}', yamlOnly).ok).toBe(false)
	})

	it("reports the YAML error when both YAML and JSON fail", () => {
		const result = parseModesYaml("customModes:\n  - slug: [unclosed\n", withJson)

		expect(result.ok).toBe(false)
	})

	it("does not normalize null coming through the JSON fallback", () => {
		// YAML 側の `?? {}` と違い JSON 経路は素通し（分割前から続く非対称性）。
		const result = parseModesYaml("\tnull", withJson)

		expect(result).toEqual({ ok: true, value: null })
	})
})
