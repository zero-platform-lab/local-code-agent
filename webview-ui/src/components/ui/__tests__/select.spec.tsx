// npx vitest run src/components/ui/__tests__/select.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
} from "../select"

describe("Select", () => {
	it("renders a select trigger with placeholder", () => {
		render(
			<Select>
				<SelectTrigger data-testid="trigger">
					<SelectValue placeholder="Pick one" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">Alpha</SelectItem>
					<SelectItem value="b">Beta</SelectItem>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByTestId("trigger")).toBeInTheDocument()
		expect(screen.getByText("Pick one")).toBeInTheDocument()
	})

	it("opens content on trigger click", () => {
		render(
			<Select>
				<SelectTrigger data-testid="trigger">
					<SelectValue placeholder="Pick" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">Alpha</SelectItem>
				</SelectContent>
			</Select>,
		)

		fireEvent.click(screen.getByTestId("trigger"))
		expect(screen.getByText("Alpha")).toBeInTheDocument()
	})

	it("merges custom className on SelectTrigger", () => {
		render(
			<Select>
				<SelectTrigger className="trigger-class" data-testid="trigger">
					<SelectValue placeholder="Pick" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">A</SelectItem>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByTestId("trigger").className).toContain("trigger-class")
	})

	it("merges custom className on SelectContent", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="content-class">
					<SelectItem value="a">A</SelectItem>
				</SelectContent>
			</Select>,
		)
		const content = document.querySelector("[data-slot='select-content']")
		expect(content!.className).toContain("content-class")
	})

	it("renders SelectContent with position=item-aligned", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="item-aligned">
					<SelectItem value="a">A</SelectItem>
				</SelectContent>
			</Select>,
		)
		const content = document.querySelector("[data-slot='select-content']")
		expect(content).toBeInTheDocument()
		// item-aligned should NOT have the popper translate classes
		expect(content!.className).not.toContain("data-[side=bottom]:translate-y-1")
	})

	it("renders SelectGroup wrapper", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						<SelectItem value="a">A</SelectItem>
					</SelectGroup>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByText("A")).toBeInTheDocument()
	})

	it("renders SelectLabel with custom className", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						<SelectLabel className="lbl-class">Category</SelectLabel>
						<SelectItem value="a">A</SelectItem>
					</SelectGroup>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByText("Category").className).toContain("lbl-class")
	})

	it("renders SelectItem with custom className", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a" className="item-class">
						A
					</SelectItem>
				</SelectContent>
			</Select>,
		)
		const item = screen.getByText("A").closest("[data-slot='select-item']")
		expect(item!.className).toContain("item-class")
	})

	it("renders SelectSeparator with custom className", () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">A</SelectItem>
					<SelectSeparator className="sep-class" data-testid="sep" />
					<SelectItem value="b">B</SelectItem>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByTestId("sep").className).toContain("sep-class")
	})

	it("renders no scroll buttons while the viewport cannot scroll", () => {
		// SelectContent は上下のスクロールボタンを常にマウントするが、Radix 側は
		// スクロール余地があるときだけ DOM を出す（jsdom ではレイアウトが 0 なので出ない）。
		// ここで固定したいのは「スクロールできないのにボタンが出ない」こと。
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">A</SelectItem>
				</SelectContent>
			</Select>,
		)
		expect(document.querySelector("[data-slot='select-content']")).toBeInTheDocument()
		expect(document.querySelector("[data-slot='select-scroll-up-button']")).toBeNull()
		expect(document.querySelector("[data-slot='select-scroll-down-button']")).toBeNull()
	})

	it("handles controlled value", () => {
		const onChange = vi.fn()
		render(
			<Select value="b" onValueChange={onChange}>
				<SelectTrigger data-testid="trigger">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">Alpha</SelectItem>
					<SelectItem value="b">Beta</SelectItem>
				</SelectContent>
			</Select>,
		)
		expect(screen.getByText("Beta")).toBeInTheDocument()
	})
})
