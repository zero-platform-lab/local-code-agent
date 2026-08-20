// npx vitest run src/components/ui/__tests__/textarea.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Textarea } from "../textarea"

describe("Textarea", () => {
	it("renders a textarea element", () => {
		render(<Textarea data-testid="ta" />)
		expect(screen.getByTestId("ta").tagName).toBe("TEXTAREA")
	})

	it("applies default styling classes", () => {
		render(<Textarea data-testid="ta" />)
		const ta = screen.getByTestId("ta")
		expect(ta.className).toContain("bg-vscode-input-background")
		expect(ta.className).toContain("text-vscode-input-foreground")
	})

	it("merges custom className", () => {
		render(<Textarea data-testid="ta" className="my-custom" />)
		expect(screen.getByTestId("ta").className).toContain("my-custom")
	})

	it("forwards native textarea props", () => {
		render(<Textarea data-testid="ta" placeholder="Type here..." disabled rows={5} />)
		const ta = screen.getByTestId("ta") as HTMLTextAreaElement
		expect(ta.placeholder).toBe("Type here...")
		expect(ta).toBeDisabled()
		expect(ta.rows).toBe(5)
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLTextAreaElement>()
		render(<Textarea ref={ref} />)
		expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
	})
})
