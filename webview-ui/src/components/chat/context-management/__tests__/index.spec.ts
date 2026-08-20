import * as barrel from "../index"

// バレル（re-export）の実行を担保する
describe("context-management barrel", () => {
	it("re-exports every context-management row component", () => {
		expect(typeof barrel.InProgressRow).toBe("function")
		expect(typeof barrel.CondensationResultRow).toBe("function")
		expect(typeof barrel.CondensationErrorRow).toBe("function")
		expect(typeof barrel.TruncationResultRow).toBe("function")
	})
})
