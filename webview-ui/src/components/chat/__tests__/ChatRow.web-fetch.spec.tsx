import React from "react"
import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ClineMessage } from "@openai-agent/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ i18nKey, values }: { i18nKey?: string; values?: Record<string, unknown> }) => (
		<>
			{i18nKey}:{String(values?.url ?? "")}
		</>
	),
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

vi.mock("@src/components/common/CodeBlock", () => ({ default: () => null }))

const queryClient = new QueryClient()

function renderChatRow(message: ClineMessage) {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={message}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
					onBatchFileResponse={() => {}}
					onFollowUpUnmount={() => {}}
					isFollowUpAnswered={false}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - webFetch approval", () => {
	it("renders the globe icon and the URL for a webFetch tool ask", () => {
		const message: ClineMessage = {
			type: "ask",
			ask: "tool",
			ts: Date.now(),
			partial: false,
			text: JSON.stringify({ tool: "webFetch", url: "https://example.com/doc" }),
		}

		const { container } = renderChatRow(message)

		expect(container.querySelector(".codicon-globe")).toBeInTheDocument()
		expect(screen.getByText(/chat:webFetch.wantsToFetch:https:\/\/example.com\/doc/)).toBeInTheDocument()
	})
})
