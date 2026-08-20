import { describe, expect, it } from "vitest"

import { stripDuplicateEnvironmentDetails } from "../stripDuplicateEnvironmentDetails"

describe("stripDuplicateEnvironmentDetails", () => {
	it("returns input unchanged when no environment_details blocks present", () => {
		const input = [
			{ type: "text" as const, text: "hello" },
			{ type: "text" as const, text: "world" },
		]
		expect(stripDuplicateEnvironmentDetails(input)).toEqual(input)
	})

	it("removes text blocks that are entirely wrapped in environment_details tags", () => {
		const input = [
			{ type: "text" as const, text: "keep me" },
			{ type: "text" as const, text: "<environment_details>old</environment_details>" },
			{ type: "text" as const, text: "keep me too" },
		]
		const out = stripDuplicateEnvironmentDetails(input)
		expect(out).toHaveLength(2)
		expect(out.map((b) => (b.type === "text" ? b.text : ""))).toEqual(["keep me", "keep me too"])
	})

	it("removes blocks with surrounding whitespace", () => {
		const input = [{ type: "text" as const, text: "  \n<environment_details>x</environment_details>\n  " }]
		expect(stripDuplicateEnvironmentDetails(input)).toEqual([])
	})

	it("keeps blocks that only mention the tag in the middle of text", () => {
		const input = [
			{ type: "text" as const, text: "prefix <environment_details>x</environment_details> suffix" },
			{ type: "text" as const, text: "just talks about <environment_details> tag" },
		]
		expect(stripDuplicateEnvironmentDetails(input)).toEqual(input)
	})

	it("does not touch non-text blocks even if their metadata mentions env details", () => {
		const input = [
			{
				type: "tool_result" as const,
				tool_use_id: "id-1",
				content: "<environment_details>irrelevant</environment_details>",
			},
		]
		expect(stripDuplicateEnvironmentDetails(input)).toEqual(input)
	})
})
