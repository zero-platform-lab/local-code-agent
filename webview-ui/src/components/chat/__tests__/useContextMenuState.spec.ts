// npx vitest run src/components/chat/__tests__/useContextMenuState.spec.ts

import { act, renderHook } from "@testing-library/react"
import { createRef } from "react"

import { ContextMenuOptionType } from "@src/utils/context-mentions"

import { useContextMenuState } from "../useContextMenuState"

/** メニュー本体を模した DOM を作り、その ref を hook に渡す。 */
const setup = () => {
	const container = document.createElement("div")
	const inside = document.createElement("button")
	container.appendChild(inside)
	document.body.appendChild(container)

	const ref = createRef<HTMLDivElement>()
	;(ref as { current: HTMLDivElement }).current = container

	const outside = document.createElement("div")
	document.body.appendChild(outside)

	const view = renderHook(() => useContextMenuState(ref))

	return {
		...view,
		container,
		inside,
		outside,
		cleanup: () => {
			container.remove()
			outside.remove()
		},
	}
}

const mouseDownOn = (el: Element) => {
	act(() => {
		el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
	})
}

describe("useContextMenuState — initial state", () => {
	it("starts closed with no selection", () => {
		const { result, cleanup } = setup()

		expect(result.current.showContextMenu).toBe(false)
		expect(result.current.searchQuery).toBe("")
		expect(result.current.selectedMenuIndex).toBe(-1)
		expect(result.current.selectedType).toBeNull()

		cleanup()
	})
})

describe("useContextMenuState — rule 1: outside click closes the menu", () => {
	it("closes when the mousedown lands outside the container", () => {
		const { result, outside, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		expect(result.current.showContextMenu).toBe(true)

		mouseDownOn(outside)
		expect(result.current.showContextMenu).toBe(false)

		cleanup()
	})

	it("stays open when the mousedown lands inside the container", () => {
		const { result, inside, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		mouseDownOn(inside)

		expect(result.current.showContextMenu).toBe(true)

		cleanup()
	})

	it("does not listen while the menu is closed", () => {
		const addSpy = vi.spyOn(document, "addEventListener")
		const { cleanup } = setup()

		expect(addSpy.mock.calls.filter(([type]) => type === "mousedown")).toHaveLength(0)

		addSpy.mockRestore()
		cleanup()
	})

	it("stops listening once the menu closes again", () => {
		const removeSpy = vi.spyOn(document, "removeEventListener")
		const { result, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.setShowContextMenu(false))

		expect(removeSpy.mock.calls.some(([type]) => type === "mousedown")).toBe(true)

		removeSpy.mockRestore()
		cleanup()
	})
})

describe("useContextMenuState — rule 2: closing discards the selected type", () => {
	it("clears selectedType when the menu closes", () => {
		const { result, cleanup } = setup()

		act(() => {
			result.current.setShowContextMenu(true)
			result.current.setSelectedType(ContextMenuOptionType.File)
		})
		expect(result.current.selectedType).toBe(ContextMenuOptionType.File)

		act(() => result.current.setShowContextMenu(false))
		expect(result.current.selectedType).toBeNull()

		cleanup()
	})

	it("keeps selectedType while the menu stays open", () => {
		const { result, cleanup } = setup()

		act(() => {
			result.current.setShowContextMenu(true)
			result.current.setSelectedType(ContextMenuOptionType.Git)
		})

		expect(result.current.selectedType).toBe(ContextMenuOptionType.Git)

		cleanup()
	})

	it("clears selectedType even when the menu was closed by an outside click", () => {
		const { result, outside, cleanup } = setup()

		act(() => {
			result.current.setShowContextMenu(true)
			result.current.setSelectedType(ContextMenuOptionType.Folder)
		})
		mouseDownOn(outside)

		expect(result.current.selectedType).toBeNull()

		cleanup()
	})
})

describe("useContextMenuState — rule 3: blur closes unless the menu was clicked", () => {
	it("closes on blur by default", () => {
		const { result, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.closeOnBlur())

		expect(result.current.showContextMenu).toBe(false)

		cleanup()
	})

	it("does not close on blur after a mousedown on the menu", () => {
		const { result, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.onMenuMouseDown())
		act(() => result.current.closeOnBlur())

		expect(result.current.showContextMenu).toBe(true)

		cleanup()
	})

	it("suppresses only the one blur caused by the menu click, not later ones", () => {
		const { result, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.onMenuMouseDown())

		// メニュークリックによる blur: 閉じない。
		act(() => result.current.closeOnBlur())
		expect(result.current.showContextMenu).toBe(true)

		// 次の blur はもう抑止されない。
		act(() => result.current.closeOnBlur())
		expect(result.current.showContextMenu).toBe(false)

		cleanup()
	})

	it("still closes on blur after the menu has been clicked once and reopened", () => {
		// 修正前は一度メニューをクリックすると、以後どれだけ開き直しても blur で
		// 閉じなくなっていた（#264 で記録した潜在バグ）。
		const { result, cleanup } = setup()

		// 1 回目: 開いてクリックして選択（選択側が閉じる）。
		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.onMenuMouseDown())
		act(() => result.current.closeOnBlur())
		act(() => result.current.setShowContextMenu(false))

		// 2 回目: 開いて、今度はメニュー以外へフォーカスを移す。
		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.closeOnBlur())

		expect(result.current.showContextMenu).toBe(false)

		cleanup()
	})

	it("survives repeated open-click cycles without getting stuck open", () => {
		const { result, cleanup } = setup()

		for (let i = 0; i < 3; i++) {
			act(() => result.current.setShowContextMenu(true))
			act(() => result.current.onMenuMouseDown())
			act(() => result.current.closeOnBlur()) // メニュークリック由来: 閉じない
			// cycle ${i}: メニュークリック直後は開いたまま
			expect(result.current.showContextMenu).toBe(true)

			act(() => result.current.closeOnBlur()) // 通常の blur: 閉じる
			// cycle ${i}: 次の blur では閉じる
			expect(result.current.showContextMenu).toBe(false)
		}

		cleanup()
	})

	it("an outside click still closes even right after a menu click", () => {
		const { result, outside, cleanup } = setup()

		act(() => result.current.setShowContextMenu(true))
		act(() => result.current.onMenuMouseDown())
		act(() => result.current.closeOnBlur())
		expect(result.current.showContextMenu).toBe(true)

		// 規則 1（外側 mousedown）はフラグの影響を受けない。
		mouseDownOn(outside)
		expect(result.current.showContextMenu).toBe(false)

		cleanup()
	})
})

describe("useContextMenuState — the remaining setters stay plain", () => {
	it("passes searchQuery and selectedMenuIndex straight through", () => {
		const { result, cleanup } = setup()

		act(() => {
			result.current.setSearchQuery("foo")
			result.current.setSelectedMenuIndex(3)
		})

		expect(result.current.searchQuery).toBe("foo")
		expect(result.current.selectedMenuIndex).toBe(3)

		cleanup()
	})

	it("supports functional updates for the selection index", () => {
		const { result, cleanup } = setup()

		act(() => result.current.setSelectedMenuIndex(2))
		act(() => result.current.setSelectedMenuIndex((i) => i + 1))

		expect(result.current.selectedMenuIndex).toBe(3)

		cleanup()
	})

	it("does not reset searchQuery or the index when the menu closes", () => {
		// 閉じたときに捨てるのは selectedType だけ。他は呼び出し側が場所ごとに決める。
		const { result, cleanup } = setup()

		act(() => {
			result.current.setShowContextMenu(true)
			result.current.setSearchQuery("keep me")
			result.current.setSelectedMenuIndex(5)
		})
		act(() => result.current.setShowContextMenu(false))

		expect(result.current.searchQuery).toBe("keep me")
		expect(result.current.selectedMenuIndex).toBe(5)

		cleanup()
	})

	it("keeps setter identities stable across renders", () => {
		// ChatTextArea 側の useCallback 依存配列に入れても再生成を増やさない前提。
		const { result, rerender, cleanup } = setup()
		const first = result.current.setShowContextMenu

		act(() => result.current.setSearchQuery("x"))
		rerender()

		expect(result.current.setShowContextMenu).toBe(first)

		cleanup()
	})
})
