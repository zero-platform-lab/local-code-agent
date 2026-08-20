// npx vitest run src/components/ui/__tests__/button.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Button, buttonVariants } from "../button"

describe("Button", () => {
	it("renders as a button element by default", () => {
		render(<Button>Click me</Button>)
		const btn = screen.getByRole("button", { name: "Click me" })
		expect(btn.tagName).toBe("BUTTON")
	})

	it("renders with default variant (secondary) and default size", () => {
		render(<Button data-testid="btn">Default</Button>)
		const btn = screen.getByTestId("btn")
		expect(btn.className).toContain("bg-secondary")
		expect(btn.className).toContain("h-7")
	})

	it("renders with primary variant", () => {
		render(
			<Button variant="primary" data-testid="btn">
				Primary
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("bg-primary")
	})

	it("renders with ghost variant", () => {
		render(
			<Button variant="ghost" data-testid="btn">
				Ghost
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("hover:bg-accent")
	})

	it("renders with destructive variant", () => {
		render(
			<Button variant="destructive" data-testid="btn">
				Destructive
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("bg-destructive")
	})

	it("renders with outline variant", () => {
		render(
			<Button variant="outline" data-testid="btn">
				Outline
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("border")
	})

	it("renders with link variant", () => {
		render(
			<Button variant="link" data-testid="btn">
				Link
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("underline-offset-4")
	})

	it("renders with combobox variant", () => {
		render(
			<Button variant="combobox" data-testid="btn">
				Combobox
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("bg-vscode-dropdown-background")
	})

	it("renders with sm size", () => {
		render(
			<Button size="sm" data-testid="btn">
				Sm
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("h-6")
	})

	it("renders with lg size", () => {
		render(
			<Button size="lg" data-testid="btn">
				Lg
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("h-8")
	})

	it("renders with icon size", () => {
		render(
			<Button size="icon" data-testid="btn">
				I
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("w-7")
	})

	it("renders as child element when asChild is true", () => {
		render(
			<Button asChild>
				<a href="/test">Link Button</a>
			</Button>,
		)
		const link = screen.getByRole("link", { name: "Link Button" })
		expect(link.tagName).toBe("A")
		expect(link.className).toContain("inline-flex")
	})

	it("merges custom className", () => {
		render(
			<Button className="my-class" data-testid="btn">
				Custom
			</Button>,
		)
		expect(screen.getByTestId("btn").className).toContain("my-class")
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLButtonElement>()
		render(<Button ref={ref}>Ref</Button>)
		expect(ref.current).toBeInstanceOf(HTMLButtonElement)
	})

	it("forwards native button props (disabled, type)", () => {
		render(
			<Button disabled type="submit" data-testid="btn">
				Disabled
			</Button>,
		)
		const btn = screen.getByTestId("btn")
		expect(btn).toBeDisabled()
		expect(btn).toHaveAttribute("type", "submit")
	})

	it("buttonVariants generates expected class strings", () => {
		expect(buttonVariants({ variant: "primary", size: "sm" })).toContain("bg-primary")
		expect(buttonVariants({ variant: "primary", size: "sm" })).toContain("h-6")
	})
})
