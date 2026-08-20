// npx vitest run core/context-tracking/__tests__/FileContextTrackerTypes.spec.ts

import { recordSourceSchema, fileMetadataEntrySchema, taskMetadataSchema } from "../FileContextTrackerTypes"

describe("FileContextTrackerTypes zod schemas", () => {
	it("recordSourceSchema は許可された 4 種のみ受け付ける", () => {
		for (const source of ["read_tool", "user_edited", "agent_edited", "file_mentioned"]) {
			expect(recordSourceSchema.parse(source)).toBe(source)
		}
		expect(recordSourceSchema.safeParse("unknown_source").success).toBe(false)
	})

	it("fileMetadataEntrySchema は必須項目を検証し、user_edit_date は任意", () => {
		const entry = {
			path: "src/app.ts",
			record_state: "active" as const,
			record_source: "read_tool" as const,
			agent_read_date: 123,
			roo_edit_date: null,
		}
		expect(fileMetadataEntrySchema.safeParse(entry).success).toBe(true)

		// record_state が範囲外なら失敗
		expect(fileMetadataEntrySchema.safeParse({ ...entry, record_state: "bogus" }).success).toBe(false)
	})

	it("taskMetadataSchema は files_in_context 配列を要求する", () => {
		expect(taskMetadataSchema.safeParse({ files_in_context: [] }).success).toBe(true)
		expect(taskMetadataSchema.safeParse({}).success).toBe(false)
	})
})
