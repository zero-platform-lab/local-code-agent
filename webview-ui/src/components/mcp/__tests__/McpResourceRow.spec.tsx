// npx vitest src/components/mcp/__tests__/McpResourceRow.spec.tsx

import { render, screen } from "@/utils/test-utils"

import type { McpResource, McpResourceTemplate } from "@openai-agent/types"

import McpResourceRow from "../McpResourceRow"

describe("McpResourceRow", () => {
	// uri を持つ McpResource（`"uri" in item` 真）。
	it("renders a resource uri, name+description, and mimeType", () => {
		const resource: McpResource = {
			uri: "file:///a.txt",
			name: "File A",
			description: "the a file",
			mimeType: "text/plain",
		}
		render(<McpResourceRow item={resource} />)

		expect(screen.getByText("file:///a.txt")).toBeInTheDocument()
		expect(screen.getByText("File A: the a file")).toBeInTheDocument()
		expect(screen.getByText("text/plain")).toBeInTheDocument()
	})

	// uriTemplate を持つ McpResourceTemplate（`"uri" in item` 偽 → uriTemplate 側）。
	it("renders a resource template uriTemplate", () => {
		const template: McpResourceTemplate = {
			uriTemplate: "file:///{path}",
			name: "Templated",
			description: "a template",
			mimeType: "application/json",
		}
		render(<McpResourceRow item={template} />)

		expect(screen.getByText("file:///{path}")).toBeInTheDocument()
		expect(screen.getByText("Templated: a template")).toBeInTheDocument()
		expect(screen.getByText("application/json")).toBeInTheDocument()
	})

	// name 無し・description のみ → description をそのまま出す。
	it("shows only the description when name is missing", () => {
		const resource = { uri: "u1", name: "", description: "just a description" } as McpResource
		render(<McpResourceRow item={resource} />)
		expect(screen.getByText("just a description")).toBeInTheDocument()
	})

	// description 無し・name のみ → name を出す。
	it("shows only the name when description is missing", () => {
		const resource = { uri: "u2", name: "OnlyName", description: "" } as McpResource
		render(<McpResourceRow item={resource} />)
		expect(screen.getByText("OnlyName")).toBeInTheDocument()
	})

	// name も description も無い → "No description"。
	it('shows "No description" when both name and description are missing', () => {
		const resource = { uri: "u3", name: "", description: "" } as McpResource
		render(<McpResourceRow item={resource} />)
		expect(screen.getByText("No description")).toBeInTheDocument()
	})

	// mimeType 無し → "Unknown"（L52 の `|| "Unknown"`）。
	it('shows "Unknown" when mimeType is missing', () => {
		const resource = { uri: "u4", name: "N", description: "D" } as McpResource
		render(<McpResourceRow item={resource} />)
		expect(screen.getByText("Unknown")).toBeInTheDocument()
	})
})
