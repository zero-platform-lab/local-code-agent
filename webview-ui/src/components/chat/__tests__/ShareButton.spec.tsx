import { render } from "@/utils/test-utils"

import { ShareButton } from "../ShareButton"

// ShareButton は現状フィーチャーフラグ的に常に null を返すが、props 受け取りの実行経路は担保する
describe("ShareButton", () => {
	it("renders nothing with no props", () => {
		expect(render(<ShareButton />).container.firstChild).toBeNull()
	})

	it("renders nothing when given an item and disabled flag", () => {
		expect(render(<ShareButton item={{ id: "1" } as any} disabled />).container.firstChild).toBeNull()
	})
})
