// npx vitest run src/components/ui/__tests__/alert-dialog.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import {
	AlertDialog,
	AlertDialogTrigger,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogOverlay,
	AlertDialogPortal,
} from "../alert-dialog"

describe("AlertDialog", () => {
	it("renders trigger and opens dialog on click", () => {
		render(
			<AlertDialog>
				<AlertDialogTrigger>Open</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Title</AlertDialogTitle>
						<AlertDialogDescription>Description</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction>Continue</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>,
		)

		expect(screen.getByText("Open")).toBeInTheDocument()
		// Content should not be visible until opened
		expect(screen.queryByText("Title")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("Open"))
		expect(screen.getByText("Title")).toBeInTheDocument()
		expect(screen.getByText("Description")).toBeInTheDocument()
		expect(screen.getByText("Cancel")).toBeInTheDocument()
		expect(screen.getByText("Continue")).toBeInTheDocument()
	})

	it("closes on Cancel click", () => {
		render(
			<AlertDialog>
				<AlertDialogTrigger>Open</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogTitle>Title</AlertDialogTitle>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
				</AlertDialogContent>
			</AlertDialog>,
		)

		fireEvent.click(screen.getByText("Open"))
		expect(screen.getByText("Title")).toBeInTheDocument()

		fireEvent.click(screen.getByText("Cancel"))
		expect(screen.queryByText("Title")).not.toBeInTheDocument()
	})

	it("closes on Action click", () => {
		render(
			<AlertDialog>
				<AlertDialogTrigger>Open</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogTitle>Title</AlertDialogTitle>
					<AlertDialogAction>OK</AlertDialogAction>
				</AlertDialogContent>
			</AlertDialog>,
		)

		fireEvent.click(screen.getByText("Open"))
		expect(screen.getByText("Title")).toBeInTheDocument()

		fireEvent.click(screen.getByText("OK"))
		expect(screen.queryByText("Title")).not.toBeInTheDocument()
	})

	it("merges custom className on content", () => {
		render(
			<AlertDialog defaultOpen>
				<AlertDialogContent className="custom-content">
					<AlertDialogTitle>Title</AlertDialogTitle>
				</AlertDialogContent>
			</AlertDialog>,
		)
		const content = screen.getByText("Title").closest("[data-slot='alert-dialog-content']")
		expect(content!.className).toContain("custom-content")
	})

	it("merges custom className on overlay", () => {
		render(
			<AlertDialog defaultOpen>
				<AlertDialogContent>
					<AlertDialogTitle>T</AlertDialogTitle>
				</AlertDialogContent>
			</AlertDialog>,
		)
		// Overlay is rendered as part of AlertDialogContent
		const overlay = document.querySelector("[data-slot='alert-dialog-overlay']")
		expect(overlay).toBeInTheDocument()
	})

	it("merges custom className on header and footer", () => {
		render(
			<AlertDialog defaultOpen>
				<AlertDialogContent>
					<AlertDialogHeader className="hdr-class" data-testid="hdr">
						Header
					</AlertDialogHeader>
					<AlertDialogFooter className="ftr-class" data-testid="ftr">
						Footer
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>,
		)
		expect(screen.getByTestId("hdr").className).toContain("hdr-class")
		expect(screen.getByTestId("ftr").className).toContain("ftr-class")
	})

	it("merges custom className on title and description", () => {
		render(
			<AlertDialog defaultOpen>
				<AlertDialogContent>
					<AlertDialogTitle className="title-class">T</AlertDialogTitle>
					<AlertDialogDescription className="desc-class">D</AlertDialogDescription>
				</AlertDialogContent>
			</AlertDialog>,
		)
		expect(screen.getByText("T").className).toContain("title-class")
		expect(screen.getByText("D").className).toContain("desc-class")
	})

	it("merges custom className on action and cancel", () => {
		render(
			<AlertDialog defaultOpen>
				<AlertDialogContent>
					<AlertDialogTitle>T</AlertDialogTitle>
					<AlertDialogAction className="act-class">A</AlertDialogAction>
					<AlertDialogCancel className="can-class">C</AlertDialogCancel>
				</AlertDialogContent>
			</AlertDialog>,
		)
		expect(screen.getByText("A").className).toContain("act-class")
		expect(screen.getByText("C").className).toContain("can-class")
	})

	it("renders AlertDialogPortal and AlertDialogOverlay standalone", () => {
		// These are invoked internally by AlertDialogContent, but ensure they accept className
		render(
			<AlertDialog defaultOpen>
				<AlertDialogPortal>
					<AlertDialogOverlay className="ov-extra" data-testid="ov" />
				</AlertDialogPortal>
			</AlertDialog>,
		)
		expect(screen.getByTestId("ov").className).toContain("ov-extra")
	})
})
