// npx vitest run src/components/ui/__tests__/badge.spec.tsx

import { render, screen } from "@/utils/test-utils"
import { Badge, badgeVariants } from "../badge"

describe("Badge", () => {
	it("renders with default variant", () => {
		render(<Badge>Default</Badge>)
		const badge = screen.getByText("Default")
		expect(badge).toBeInTheDocument()
		expect(badge.className).toContain("bg-primary")
	})

	it("renders with secondary variant", () => {
		render(<Badge variant="secondary">Secondary</Badge>)
		const badge = screen.getByText("Secondary")
		expect(badge.className).toContain("bg-secondary")
	})

	it("renders with destructive variant", () => {
		render(<Badge variant="destructive">Destructive</Badge>)
		const badge = screen.getByText("Destructive")
		expect(badge.className).toContain("bg-destructive")
	})

	it("renders with outline variant", () => {
		render(<Badge variant="outline">Outline</Badge>)
		const badge = screen.getByText("Outline")
		expect(badge.className).toContain("border-vscode-input-border")
	})

	it("merges custom className", () => {
		render(<Badge className="custom-class">Custom</Badge>)
		const badge = screen.getByText("Custom")
		expect(badge.className).toContain("custom-class")
	})

	it("forwards extra HTML attributes", () => {
		render(<Badge data-testid="test-badge">Attrs</Badge>)
		expect(screen.getByTestId("test-badge")).toBeInTheDocument()
	})

	it("badgeVariants produces correct classes for each variant", () => {
		expect(badgeVariants({ variant: "default" })).toContain("bg-primary")
		expect(badgeVariants({ variant: "secondary" })).toContain("bg-secondary")
		expect(badgeVariants({ variant: "destructive" })).toContain("bg-destructive")
		expect(badgeVariants({ variant: "outline" })).toContain("border-vscode-input-border")
	})
})
