import { describe, it, expect } from "vitest"

import { findMatchingTemplate, findMatchingResourceOrTemplate } from "../mcp"

import type { McpResource, McpResourceTemplate } from "@openai-agent/types"

describe("findMatchingTemplate", () => {
	const templates: McpResourceTemplate[] = [
		{ uriTemplate: "file:///{path}", name: "File", description: "A file resource" },
		{ uriTemplate: "db://users/{id}", name: "User", description: "A user record" },
		{ uriTemplate: "api://v1/{service}/{action}", name: "API", description: "An API endpoint" },
	]

	it("matches a URI to the correct template", () => {
		const result = findMatchingTemplate("file:///index.ts", templates)
		expect(result).toEqual(templates[0])
	})

	// {param} は RFC 6570 の単純展開と同じくスラッシュを跨がない（実装コメントどおり）。
	it("does not let a {param} span path separators", () => {
		expect(findMatchingTemplate("file:///src/index.ts", templates)).toBeUndefined()
	})

	it("matches a URI with multiple segments", () => {
		const result = findMatchingTemplate("api://v1/auth/login", templates)
		expect(result).toEqual(templates[2])
	})

	it("returns undefined when no template matches", () => {
		expect(findMatchingTemplate("http://example.com", templates)).toBeUndefined()
	})

	it("returns undefined when templates array is empty", () => {
		expect(findMatchingTemplate("file:///foo", [])).toBeUndefined()
	})

	it("returns undefined when templates is not provided", () => {
		expect(findMatchingTemplate("file:///foo")).toBeUndefined()
	})

	it("handles templates with special regex characters", () => {
		const specialTemplates: McpResourceTemplate[] = [
			{ uriTemplate: "data://items[{id}]", name: "Item", description: "An item" },
		]
		const result = findMatchingTemplate("data://items[42]", specialTemplates)
		expect(result).toEqual(specialTemplates[0])
	})

	// --- Mutation kills ---
	it("requires a match at the start of the URI", () => {
		expect(findMatchingTemplate("xdb://users/42", templates)).toBeUndefined()
	})

	it("requires a match to the end of the URI", () => {
		expect(findMatchingTemplate("db://users/42/extra", templates)).toBeUndefined()
	})

	it("does not match empty URI", () => {
		expect(findMatchingTemplate("", templates)).toBeUndefined()
	})
})

describe("findMatchingResourceOrTemplate", () => {
	const resources: McpResource[] = [
		{ uri: "file:///README.md", name: "README", description: "Readme file", mimeType: "text/markdown" },
	]

	const templates: McpResourceTemplate[] = [
		{ uriTemplate: "file:///{path}", name: "File", description: "A file resource" },
	]

	it("finds an exact resource match first", () => {
		const result = findMatchingResourceOrTemplate("file:///README.md", resources, templates)
		expect(result).toEqual(resources[0])
	})

	it("falls back to template match when no exact resource match", () => {
		const result = findMatchingResourceOrTemplate("file:///index.ts", resources, templates)
		expect(result).toEqual(templates[0])
	})

	it("returns undefined when neither resource nor template matches", () => {
		expect(findMatchingResourceOrTemplate("http://example.com", resources, templates)).toBeUndefined()
	})

	it("returns undefined with empty arrays", () => {
		expect(findMatchingResourceOrTemplate("file:///foo", [], [])).toBeUndefined()
	})

	it("handles default parameters (empty arrays)", () => {
		expect(findMatchingResourceOrTemplate("file:///foo")).toBeUndefined()
	})

	// --- Mutation kills ---
	it("prefers exact resource match over template match for the same URI", () => {
		// Both resource and template would match this URI
		const result = findMatchingResourceOrTemplate("file:///README.md", resources, templates)
		// Must return the resource (exact match), not the template
		expect(result).toBe(resources[0])
		expect((result as McpResource).uri).toBe("file:///README.md")
	})
})
