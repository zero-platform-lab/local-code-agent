// npx vitest run src/components/ui/__tests__/table.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Table, TableBody, TableRow, TableCell } from "../table"

describe("Table", () => {
	it("renders a table element with default styling", () => {
		render(
			<Table data-testid="tbl">
				<TableBody>
					<TableRow>
						<TableCell>Cell</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		const tbl = screen.getByTestId("tbl")
		expect(tbl.tagName).toBe("TABLE")
		expect(tbl.className).toContain("w-full")
	})

	it("merges custom className on Table", () => {
		render(
			<Table data-testid="tbl" className="extra">
				<TableBody>
					<TableRow>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(screen.getByTestId("tbl").className).toContain("extra")
	})

	it("forwards ref on Table", () => {
		const ref = React.createRef<HTMLTableElement>()
		render(
			<Table ref={ref}>
				<TableBody>
					<TableRow>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(ref.current).toBeInstanceOf(HTMLTableElement)
	})

	it("renders TableBody with custom className", () => {
		render(
			<Table>
				<TableBody data-testid="tbody" className="body-class">
					<TableRow>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(screen.getByTestId("tbody").className).toContain("body-class")
	})

	it("forwards ref on TableBody", () => {
		const ref = React.createRef<HTMLTableSectionElement>()
		render(
			<Table>
				<TableBody ref={ref}>
					<TableRow>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(ref.current).toBeInstanceOf(HTMLTableSectionElement)
	})

	it("renders TableRow with custom className", () => {
		render(
			<Table>
				<TableBody>
					<TableRow data-testid="tr" className="row-class">
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(screen.getByTestId("tr").className).toContain("row-class")
	})

	it("forwards ref on TableRow", () => {
		const ref = React.createRef<HTMLTableRowElement>()
		render(
			<Table>
				<TableBody>
					<TableRow ref={ref}>
						<TableCell>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(ref.current).toBeInstanceOf(HTMLTableRowElement)
	})

	it("renders TableCell with default styling", () => {
		render(
			<Table>
				<TableBody>
					<TableRow>
						<TableCell data-testid="td">Content</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		const td = screen.getByTestId("td")
		expect(td.tagName).toBe("TD")
		expect(td.className).toContain("py-0.5")
	})

	it("merges custom className on TableCell", () => {
		render(
			<Table>
				<TableBody>
					<TableRow>
						<TableCell data-testid="td" className="cell-class">
							C
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(screen.getByTestId("td").className).toContain("cell-class")
	})

	it("forwards ref on TableCell", () => {
		const ref = React.createRef<HTMLTableCellElement>()
		render(
			<Table>
				<TableBody>
					<TableRow>
						<TableCell ref={ref}>C</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		)
		expect(ref.current).toBeInstanceOf(HTMLTableCellElement)
	})
})
