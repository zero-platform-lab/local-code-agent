import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import ContextMenu from "../ContextMenu"
import { ContextMenuOptionType, type ContextMenuQueryItem } from "@src/utils/context-mentions"

// Mock vscode
vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

// Mock context-mentions module
vi.mock("@src/utils/context-mentions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/utils/context-mentions")>()
	return {
		...actual,
		// Return queryItems directly so we control what renders
		getContextMenuOptions: vi.fn((_q: string, _sel: any, items: ContextMenuQueryItem[]) => items),
	}
})

// Mock removeLeadingNonAlphanumeric
vi.mock("@src/utils/removeLeadingNonAlphanumeric", () => ({
	removeLeadingNonAlphanumeric: (s: string) => s,
}))

// Mock docLinks
vi.mock("@/utils/docLinks", () => ({
	buildDocLink: (path: string, _src: string) => `https://docs.example.com/${path}`,
}))

// Mock react-i18next
vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-i18next")>()
	return {
		...actual,
		Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => (
			<span data-i18nkey={i18nKey}>{children}</span>
		),
	}
})

// Mock i18next
vi.mock("i18next", () => ({
	t: (key: string) => key,
}))

// Mock vscode-material-icons
vi.mock("vscode-material-icons", () => ({
	getIconForFilePath: (_name: string) => "file-icon",
	getIconUrlByName: (name: string, base: string) => `${base}/${name}.svg`,
	getIconForDirectoryPath: (_name: string) => "folder-icon",
}))

const defaultProps = {
	onSelect: vi.fn(),
	searchQuery: "",
	inputValue: "",
	onMouseDown: vi.fn(),
	selectedIndex: 0,
	setSelectedIndex: vi.fn(),
	selectedType: null,
	queryItems: [] as ContextMenuQueryItem[],
}

describe("ContextMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Set MATERIAL_ICONS_BASE_URI on window
		;(window as any).MATERIAL_ICONS_BASE_URI = "https://icons"
	})

	// ---------- Empty state ----------
	it("shows 'no results' when filteredOptions is empty", () => {
		render(<ContextMenu {...defaultProps} queryItems={[]} />)
		expect(screen.getByText("chat:contextMenu.noResults")).toBeInTheDocument()
	})

	// ---------- SectionHeader ----------
	it("renders SectionHeader option as non-selectable bold text", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.SectionHeader, label: "Commands" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("Commands")).toBeInTheDocument()
	})

	// ---------- Mode ----------
	it("renders Mode option with slash command and description", () => {
		const items: ContextMenuQueryItem[] = [
			{
				type: ContextMenuOptionType.Mode,
				slashCommand: "/architect",
				description: "Design mode",
			},
		]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("/architect")).toBeInTheDocument()
		expect(screen.getByText("Design mode")).toBeInTheDocument()
	})

	it("renders Mode option without description", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Mode, slashCommand: "/code" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("/code")).toBeInTheDocument()
	})

	// ---------- Command ----------
	it("renders Command option with slash command, argumentHint and description", () => {
		const items: ContextMenuQueryItem[] = [
			{
				type: ContextMenuOptionType.Command,
				slashCommand: "/run",
				argumentHint: "<script>",
				description: "Run a script",
			},
		]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("/run")).toBeInTheDocument()
		expect(screen.getByText("<script>")).toBeInTheDocument()
		expect(screen.getByText("Run a script")).toBeInTheDocument()
	})

	it("renders Command option without argumentHint or description", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Command, slashCommand: "/help" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("/help")).toBeInTheDocument()
	})

	// ---------- Problems ----------
	it("renders Problems option", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Problems }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("chat:contextMenu.problems")).toBeInTheDocument()
	})

	// ---------- Terminal ----------
	it("renders Terminal option", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Terminal }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("chat:contextMenu.terminal")).toBeInTheDocument()
	})

	// ---------- URL ----------
	it("renders URL option (non-selectable)", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.URL }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("chat:contextMenu.url")).toBeInTheDocument()
	})

	// ---------- NoResults ----------
	it("renders NoResults option", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.NoResults }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("chat:contextMenu.noResults")).toBeInTheDocument()
	})

	// ---------- Git with value ----------
	it("renders Git option with value showing label and description", () => {
		const items: ContextMenuQueryItem[] = [
			{
				type: ContextMenuOptionType.Git,
				value: "abc123",
				label: "fix: bug",
				description: "Fixed a critical bug",
			},
		]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("fix: bug")).toBeInTheDocument()
		expect(screen.getByText("Fixed a critical bug")).toBeInTheDocument()
	})

	// ---------- Git without value ----------
	it("renders Git option without value as 'Git Commits'", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Git }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("Git Commits")).toBeInTheDocument()
	})

	// ---------- File with value ----------
	it("renders File option with value showing filename and folder path", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File, value: "src/components/App.tsx" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("App.tsx")).toBeInTheDocument()
		expect(screen.getByText("src/components")).toBeInTheDocument()
	})

	// ---------- File without value ----------
	it("renders File option without value as 'Add File'", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("Add File")).toBeInTheDocument()
	})

	// ---------- Folder with value ----------
	it("renders Folder option with value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Folder, value: "src/utils/" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		// trailing slash removed, then split
		expect(screen.getByText("utils")).toBeInTheDocument()
	})

	// ---------- Folder without value ----------
	it("renders Folder option without value as 'Add Folder'", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Folder }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("Add Folder")).toBeInTheDocument()
	})

	// ---------- OpenedFile with value ----------
	it("renders OpenedFile option with value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.OpenedFile, value: "src/index.ts" }]
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("index.ts")).toBeInTheDocument()
	})

	// ---------- Selection / Click ----------
	it("calls onSelect when a selectable option is clicked", () => {
		const onSelect = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Terminal }]
		render(<ContextMenu {...defaultProps} onSelect={onSelect} queryItems={items} />)
		fireEvent.click(screen.getByText("chat:contextMenu.terminal"))
		expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.Terminal, undefined)
	})

	it("does not call onSelect when NoResults is clicked", () => {
		const onSelect = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.NoResults }]
		render(<ContextMenu {...defaultProps} onSelect={onSelect} queryItems={items} />)
		fireEvent.click(screen.getByText("chat:contextMenu.noResults"))
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("does not call onSelect when URL option is clicked", () => {
		const onSelect = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.URL }]
		render(<ContextMenu {...defaultProps} onSelect={onSelect} queryItems={items} />)
		fireEvent.click(screen.getByText("chat:contextMenu.url"))
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("does not call onSelect when SectionHeader is clicked", () => {
		const onSelect = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.SectionHeader, label: "Section" }]
		render(<ContextMenu {...defaultProps} onSelect={onSelect} queryItems={items} />)
		fireEvent.click(screen.getByText("Section"))
		expect(onSelect).not.toHaveBeenCalled()
	})

	// ---------- Hover / selectedIndex ----------
	it("calls setSelectedIndex on mouse enter for selectable options", () => {
		const setSelectedIndex = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Terminal }]
		render(<ContextMenu {...defaultProps} setSelectedIndex={setSelectedIndex} queryItems={items} />)
		// The option div is the parent of the text
		const optionText = screen.getByText("chat:contextMenu.terminal")
		fireEvent.mouseEnter(optionText.closest("[style]")!)
		expect(setSelectedIndex).toHaveBeenCalledWith(0)
	})

	it("does not call setSelectedIndex on mouse enter for non-selectable options", () => {
		const setSelectedIndex = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.NoResults }]
		render(<ContextMenu {...defaultProps} setSelectedIndex={setSelectedIndex} queryItems={items} />)
		const optionText = screen.getByText("chat:contextMenu.noResults")
		fireEvent.mouseEnter(optionText.closest("[style]")!)
		expect(setSelectedIndex).not.toHaveBeenCalled()
	})

	// ---------- Slash command header and settings button ----------
	it("shows slash command header and settings button when searchQuery is '/'", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Command, slashCommand: "/help" }]
		render(<ContextMenu {...defaultProps} searchQuery="/" queryItems={items} />)
		expect(screen.getByText("Slash Commands")).toBeInTheDocument()
		expect(screen.getByTitle("chat:slashCommands.manageCommands")).toBeInTheDocument()
	})

	it("sends switchTab message when settings button is clicked", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Command, slashCommand: "/help" }]
		render(<ContextMenu {...defaultProps} searchQuery="/" queryItems={items} />)
		const settingsButton = screen.getByTitle("chat:slashCommands.manageCommands")
		fireEvent.click(settingsButton)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "slashCommands" },
		})
	})

	it("handles mouseDown on settings button (stopPropagation + preventDefault)", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Command, slashCommand: "/help" }]
		render(<ContextMenu {...defaultProps} searchQuery="/" queryItems={items} />)
		const settingsButton = screen.getByTitle("chat:slashCommands.manageCommands")
		const event = new MouseEvent("mousedown", { bubbles: true })
		const stopPropagation = vi.spyOn(event, "stopPropagation")
		const preventDefault = vi.spyOn(event, "preventDefault")
		fireEvent(settingsButton, event)
		expect(stopPropagation).toHaveBeenCalled()
		expect(preventDefault).toHaveBeenCalled()
	})

	it("handles mouseEnter/mouseLeave on settings button to change style", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Command, slashCommand: "/help" }]
		render(<ContextMenu {...defaultProps} searchQuery="/" queryItems={items} />)
		const settingsButton = screen.getByTitle("chat:slashCommands.manageCommands")
		fireEvent.mouseEnter(settingsButton)
		expect(settingsButton.style.opacity).toBe("1")
		fireEvent.mouseLeave(settingsButton)
		expect(settingsButton.style.opacity).toBe("0.7")
	})

	// ---------- Scroll behavior ----------
	it("scrolls down when selected element is below visible area", () => {
		const items: ContextMenuQueryItem[] = Array.from({ length: 5 }, (_, i) => ({
			type: ContextMenuOptionType.Terminal,
			value: `item${i}`,
		}))
		const { container, rerender } = render(<ContextMenu {...defaultProps} queryItems={items} selectedIndex={0} />)
		// Mock getBoundingClientRect to simulate scroll-down needed
		const menuEl = container.querySelector("[style]")!.firstElementChild as HTMLElement
		const children = menuEl.children
		// Menu rect: top=0, bottom=100
		vi.spyOn(menuEl, "getBoundingClientRect").mockReturnValue({
			top: 0,
			bottom: 100,
			left: 0,
			right: 0,
			width: 0,
			height: 100,
			x: 0,
			y: 0,
			toJSON: () => {},
		})
		// Child rect: bottom=150 (overflows bottom)
		if (children[2]) {
			vi.spyOn(children[2] as HTMLElement, "getBoundingClientRect").mockReturnValue({
				top: 80,
				bottom: 150,
				left: 0,
				right: 0,
				width: 0,
				height: 70,
				x: 0,
				y: 0,
				toJSON: () => {},
			})
		}
		rerender(<ContextMenu {...defaultProps} queryItems={items} selectedIndex={2} />)
		// scrollTop should have been adjusted
		expect(menuEl.scrollTop).toBe(50)
	})

	it("scrolls up when selected element is above visible area", () => {
		const items: ContextMenuQueryItem[] = Array.from({ length: 5 }, (_, i) => ({
			type: ContextMenuOptionType.Terminal,
			value: `item${i}`,
		}))
		const { container, rerender } = render(<ContextMenu {...defaultProps} queryItems={items} selectedIndex={4} />)
		const menuEl = container.querySelector("[style]")!.firstElementChild as HTMLElement
		const children = menuEl.children
		// Menu rect: top=50, bottom=200
		vi.spyOn(menuEl, "getBoundingClientRect").mockReturnValue({
			top: 50,
			bottom: 200,
			left: 0,
			right: 0,
			width: 0,
			height: 150,
			x: 0,
			y: 0,
			toJSON: () => {},
		})
		// Child rect: top=10 (above menu top)
		if (children[1]) {
			vi.spyOn(children[1] as HTMLElement, "getBoundingClientRect").mockReturnValue({
				top: 10,
				bottom: 40,
				left: 0,
				right: 0,
				width: 0,
				height: 30,
				x: 0,
				y: 0,
				toJSON: () => {},
			})
		}
		rerender(<ContextMenu {...defaultProps} queryItems={items} selectedIndex={1} />)
		// scrollTop should have been decreased
		// Initial scrollTop is 0, so 0 - (50 - 10) = -40 which the browser would clamp to 0
		// But in JSDOM we just verify the assignment happened
		expect(menuEl.scrollTop).toBe(-40)
	})

	// ---------- Chevron icons ----------
	it("renders chevron-right for File option without value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(container.querySelector(".codicon-chevron-right")).toBeInTheDocument()
	})

	it("renders chevron-right for Folder option without value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Folder }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(container.querySelector(".codicon-chevron-right")).toBeInTheDocument()
	})

	it("renders chevron-right for Git option without value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Git }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(container.querySelector(".codicon-chevron-right")).toBeInTheDocument()
	})

	it("does not render chevron-right for File option with value", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File, value: "test.ts" }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(container.querySelector(".codicon-chevron-right")).not.toBeInTheDocument()
	})

	// ---------- Material icons ----------
	it("renders material icon for File options", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File, value: "test.ts" }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		const img = container.querySelector("img")
		expect(img).toBeInTheDocument()
		expect(img!.src).toContain("file-icon.svg")
	})

	it("renders material icon for Folder options", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.Folder, value: "src/" }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		const img = container.querySelector("img")
		expect(img).toBeInTheDocument()
		expect(img!.src).toContain("folder-icon.svg")
	})

	it("renders material icon for OpenedFile options", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.OpenedFile, value: "index.ts" }]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} />)
		const img = container.querySelector("img")
		expect(img).toBeInTheDocument()
	})

	// ---------- Codicon icons for non-file/folder types ----------
	it("renders codicon for Terminal, Problems, URL, Git, NoResults", () => {
		const types = [
			{ type: ContextMenuOptionType.Terminal, icon: "codicon-terminal" },
			{ type: ContextMenuOptionType.Problems, icon: "codicon-warning" },
			{ type: ContextMenuOptionType.URL, icon: "codicon-link" },
			{ type: ContextMenuOptionType.Git, label: "fix", value: "abc", icon: "codicon-git-commit" },
			{ type: ContextMenuOptionType.NoResults, icon: "codicon-info" },
		]
		for (const { type, icon, label, value } of types) {
			const items: ContextMenuQueryItem[] = [{ type, label, value } as ContextMenuQueryItem]
			const { container, unmount } = render(<ContextMenu {...defaultProps} queryItems={items} />)
			expect(container.querySelector(`.${icon}`)).toBeInTheDocument()
			unmount()
		}
	})

	// ---------- getMaterialIconForOption handles undefined value ----------
	it("handles option with undefined value in getMaterialIconForOption", () => {
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File, value: undefined }]
		// Should not throw; renders "Add File" text
		render(<ContextMenu {...defaultProps} queryItems={items} />)
		expect(screen.getByText("Add File")).toBeInTheDocument()
	})

	// ---------- selectedIndex highlight ----------
	it("applies active selection style to selectedIndex item", () => {
		const items: ContextMenuQueryItem[] = [
			{ type: ContextMenuOptionType.Terminal },
			{ type: ContextMenuOptionType.Problems },
		]
		const { container } = render(<ContextMenu {...defaultProps} queryItems={items} selectedIndex={1} />)
		// The second item (index 1) should have active selection background
		// Check the raw HTML for the style string since JSDOM doesn't always parse CSS variables
		expect(container.innerHTML).toContain("--vscode-list-activeSelectionBackground")
	})

	// ---------- onSelect with File value ----------
	it("calls onSelect with type and value for file with value", () => {
		const onSelect = vi.fn()
		const items: ContextMenuQueryItem[] = [{ type: ContextMenuOptionType.File, value: "test.ts" }]
		render(<ContextMenu {...defaultProps} onSelect={onSelect} queryItems={items} />)
		fireEvent.click(screen.getByText("test.ts"))
		expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.File, "test.ts")
	})
})
