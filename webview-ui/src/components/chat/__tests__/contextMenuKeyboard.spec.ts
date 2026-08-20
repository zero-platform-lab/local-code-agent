// npx vitest run src/components/chat/__tests__/contextMenuKeyboard.spec.ts

import { ContextMenuOptionType, type ContextMenuQueryItem } from "@src/utils/context-mentions"

import { isSelectableOption, moveMenuSelection, selectableOptionAt } from "../contextMenuKeyboard"

const opt = (type: ContextMenuOptionType, value = "v"): ContextMenuQueryItem =>
	({ type, value }) as ContextMenuQueryItem

const FILE = () => opt(ContextMenuOptionType.File, "f")
const FOLDER = () => opt(ContextMenuOptionType.Folder, "d")
const HEADER = () => opt(ContextMenuOptionType.SectionHeader, "h")
const NO_RESULTS = () => opt(ContextMenuOptionType.NoResults, "n")
const URL = () => opt(ContextMenuOptionType.URL, "u")

describe("isSelectableOption", () => {
	it.each([
		["File", ContextMenuOptionType.File],
		["Folder", ContextMenuOptionType.Folder],
		["Git", ContextMenuOptionType.Git],
		["OpenedFile", ContextMenuOptionType.OpenedFile],
	])("treats %s as selectable", (_label, type) => {
		expect(isSelectableOption(opt(type))).toBe(true)
	})

	it.each([
		["URL", ContextMenuOptionType.URL],
		["NoResults", ContextMenuOptionType.NoResults],
		["SectionHeader", ContextMenuOptionType.SectionHeader],
	])("treats %s as not selectable", (_label, type) => {
		expect(isSelectableOption(opt(type))).toBe(false)
	})
})

describe("moveMenuSelection — degenerate lists", () => {
	it("keeps the current index when there are no options at all", () => {
		expect(moveMenuSelection([], 4, 1)).toBe(4)
		expect(moveMenuSelection([], -1, -1)).toBe(-1)
	})

	it("reports no selection when nothing in the list is selectable", () => {
		expect(moveMenuSelection([HEADER(), NO_RESULTS(), URL()], 0, 1)).toBe(-1)
	})
})

describe("moveMenuSelection — moving down", () => {
	it("advances to the next selectable option", () => {
		const options = [FILE(), FOLDER()]

		expect(moveMenuSelection(options, 0, 1)).toBe(1)
	})

	it("skips over headers and other unselectable rows", () => {
		//        0        1       2         3
		const options = [HEADER(), FILE(), HEADER(), FOLDER()]

		expect(moveMenuSelection(options, 1, 1)).toBe(3)
	})

	it("wraps from the last selectable option back to the first", () => {
		const options = [FILE(), FOLDER()]

		expect(moveMenuSelection(options, 1, 1)).toBe(0)
	})

	it("lands on the first selectable option when nothing is selected yet", () => {
		const options = [HEADER(), FILE(), FOLDER()]

		expect(moveMenuSelection(options, -1, 1)).toBe(1)
	})
})

describe("moveMenuSelection — moving up", () => {
	it("steps back to the previous selectable option", () => {
		const options = [FILE(), FOLDER()]

		expect(moveMenuSelection(options, 1, -1)).toBe(0)
	})

	it("wraps from the first selectable option to the last", () => {
		const options = [FILE(), FOLDER()]

		expect(moveMenuSelection(options, 0, -1)).toBe(1)
	})

	it("lands on the second-to-last selectable option from no selection (pre-existing quirk)", () => {
		// 現在位置が選択不能/範囲外だと currentSelectableIndex が -1 になり、
		// Up では (-1 - 1 + n) % n = n-2 に飛ぶ。分割前からの挙動なのでここで固定する。
		const options = [FILE(), FOLDER(), opt(ContextMenuOptionType.Git, "g")]

		expect(moveMenuSelection(options, -1, -1)).toBe(1)
	})

	it("still wraps sensibly when there is exactly one selectable option", () => {
		const options = [HEADER(), FILE()]

		expect(moveMenuSelection(options, -1, -1)).toBe(1)
		expect(moveMenuSelection(options, 1, -1)).toBe(1)
		expect(moveMenuSelection(options, 1, 1)).toBe(1)
	})
})

describe("moveMenuSelection — identity, not equality", () => {
	it("distinguishes two options that look identical", () => {
		// 値の等しい候補が混ざり得るので、位置の特定は参照同一性で行う。
		const first = FILE()
		const second = FILE()
		const options = [first, second]

		expect(moveMenuSelection(options, 0, 1)).toBe(1)
		expect(moveMenuSelection(options, 1, 1)).toBe(0)
	})

	it("treats an out-of-range index as no selection", () => {
		const options = [FILE(), FOLDER()]

		expect(moveMenuSelection(options, 99, 1)).toBe(0)
	})
})

describe("selectableOptionAt", () => {
	it("returns the option when it can be chosen", () => {
		const options = [HEADER(), FILE()]

		expect(selectableOptionAt(options, 1)).toBe(options[1])
	})

	it.each([
		["a section header", 0],
		["an out-of-range index", 5],
	])("returns nothing for %s", (_label, index) => {
		expect(selectableOptionAt([HEADER(), FILE()], index)).toBeUndefined()
	})

	it("returns nothing for a URL row", () => {
		expect(selectableOptionAt([URL()], 0)).toBeUndefined()
	})

	it("returns nothing for a no-results row", () => {
		expect(selectableOptionAt([NO_RESULTS()], 0)).toBeUndefined()
	})

	it("returns nothing for index -1", () => {
		expect(selectableOptionAt([FILE()], -1)).toBeUndefined()
	})
})
