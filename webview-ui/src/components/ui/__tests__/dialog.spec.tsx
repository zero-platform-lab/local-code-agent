// npx vitest run src/components/ui/__tests__/dialog.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import {
	Dialog,
	DialogTrigger,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	DialogClose,
} from "../dialog"

describe("Dialog", () => {
	it("renders trigger and opens dialog on click", () => {
		render(
			<Dialog>
				<DialogTrigger>Open</DialogTrigger>
				<DialogContent>
					<DialogTitle>Dialog Title</DialogTitle>
					<DialogDescription>Dialog Description</DialogDescription>
				</DialogContent>
			</Dialog>,
		)

		expect(screen.getByText("Open")).toBeInTheDocument()
		expect(screen.queryByText("Dialog Title")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("Open"))
		expect(screen.getByText("Dialog Title")).toBeInTheDocument()
		expect(screen.getByText("Dialog Description")).toBeInTheDocument()
	})

	it("includes a close button inside DialogContent", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>T</DialogTitle>
				</DialogContent>
			</Dialog>,
		)
		// The built-in close button has an sr-only "Close" text
		expect(screen.getByText("Close")).toBeInTheDocument()
	})

	it("closes when close button is clicked", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>Content</DialogTitle>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByText("Content")).toBeInTheDocument()
		// Click the close button (the sr-only "Close" text's parent button)
		const closeBtn = screen.getByText("Close").closest("button")!
		fireEvent.click(closeBtn)
		expect(screen.queryByText("Content")).not.toBeInTheDocument()
	})

	it("merges custom className on DialogContent", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent className="custom-dialog">
					<DialogTitle>T</DialogTitle>
				</DialogContent>
			</Dialog>,
		)
		const content = document.querySelector("[data-slot='dialog-content']")
		expect(content!.className).toContain("custom-dialog")
	})

	it("renders DialogHeader with custom className", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogHeader className="hdr" data-testid="hdr">
						<DialogTitle>T</DialogTitle>
					</DialogHeader>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByTestId("hdr").className).toContain("hdr")
	})

	it("renders DialogFooter with custom className", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>T</DialogTitle>
					<DialogFooter className="ftr" data-testid="ftr">
						Buttons here
					</DialogFooter>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByTestId("ftr").className).toContain("ftr")
	})

	it("renders DialogTitle with custom className", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle className="title-extra">My Title</DialogTitle>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByText("My Title").className).toContain("title-extra")
	})

	it("renders DialogDescription with custom className", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>T</DialogTitle>
					<DialogDescription className="desc-extra">My Desc</DialogDescription>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByText("My Desc").className).toContain("desc-extra")
	})

	it("renders DialogClose standalone", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>T</DialogTitle>
					<DialogClose data-testid="custom-close">Done</DialogClose>
				</DialogContent>
			</Dialog>,
		)
		expect(screen.getByTestId("custom-close")).toBeInTheDocument()
	})

	it("renders DialogOverlay and DialogPortal with data-slot", () => {
		render(
			<Dialog defaultOpen>
				<DialogContent>
					<DialogTitle>T</DialogTitle>
				</DialogContent>
			</Dialog>,
		)
		expect(document.querySelector("[data-slot='dialog-overlay']")).toBeInTheDocument()
	})
})
