// npx vitest src/components/modes/__tests__/ModeSelectPopover.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"

import type { ModeConfig } from "@openai-agent/types"

import { ModeSelectPopover } from "../ModeSelectPopover"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const baseProps = () => ({
	open: false,
	onOpenChange: vi.fn(),
	modes: [] as ModeConfig[],
	searchValue: "",
	onSearchChange: vi.fn(),
	onClearSearch: vi.fn(),
	searchInputRef: { current: null } as React.RefObject<HTMLInputElement>,
	onSelect: vi.fn(),
})

describe("ModeSelectPopover", () => {
	it("shows the current mode name in the trigger when provided", () => {
		render(<ModeSelectPopover {...baseProps()} currentModeName="My Mode" />)
		expect(screen.getByTestId("mode-select-trigger")).toHaveTextContent("My Mode")
	})

	// currentModeName 未指定なら "selectMode" の既定文言にフォールバックする（L59 の `?? t(...)`）。
	it("falls back to the selectMode label when no current mode name is given", () => {
		render(<ModeSelectPopover {...baseProps()} currentModeName={undefined} />)
		expect(screen.getByTestId("mode-select-trigger")).toHaveTextContent("prompts:modes.selectMode")
	})
})
