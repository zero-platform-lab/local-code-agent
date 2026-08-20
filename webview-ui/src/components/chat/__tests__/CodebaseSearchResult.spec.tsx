import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import CodebaseSearchResult from "../CodebaseSearchResult"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts)}` }),
}))

vi.mock("@/components/ui", () => ({
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

const baseProps = {
	filePath: "src/dir/file.ts",
	score: 0.123456,
	startLine: 10,
	endLine: 20,
	snippet: "code",
	language: "typescript",
}

describe("CodebaseSearchResult", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows the file name with a line range when start != end", () => {
		render(<CodebaseSearchResult {...baseProps} />)
		expect(screen.getByText("file.ts:10-20")).toBeInTheDocument()
		// ディレクトリ部分
		expect(screen.getByText("src/dir")).toBeInTheDocument()
		// スコアは 3 桁固定
		expect(screen.getByText("0.123")).toBeInTheDocument()
	})

	it("shows a single line number when start === end", () => {
		render(<CodebaseSearchResult {...baseProps} startLine={5} endLine={5} />)
		expect(screen.getByText("file.ts:5")).toBeInTheDocument()
	})

	it("posts openFile with the start line on click", () => {
		render(<CodebaseSearchResult {...baseProps} />)
		fireEvent.click(screen.getByText("file.ts:10-20"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "./src/dir/file.ts",
			values: { line: 10 },
		})
	})
})
