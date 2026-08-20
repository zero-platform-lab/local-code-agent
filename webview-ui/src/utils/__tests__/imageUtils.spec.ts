import { describe, it, expect } from "vitest"

import { appendImages } from "../imageUtils"

describe("appendImages", () => {
	it("returns current images when newImages is undefined", () => {
		expect(appendImages(["a.png"], undefined, 5)).toEqual(["a.png"])
	})

	it("returns current images when newImages is empty", () => {
		expect(appendImages(["a.png"], [], 5)).toEqual(["a.png"])
	})

	it("appends new images to current images", () => {
		expect(appendImages(["a.png"], ["b.png", "c.png"], 5)).toEqual(["a.png", "b.png", "c.png"])
	})

	it("truncates to maxImages", () => {
		expect(appendImages(["a.png", "b.png"], ["c.png", "d.png"], 3)).toEqual(["a.png", "b.png", "c.png"])
	})

	it("handles empty current images", () => {
		expect(appendImages([], ["a.png", "b.png"], 5)).toEqual(["a.png", "b.png"])
	})

	it("handles maxImages of 0", () => {
		expect(appendImages(["a.png"], ["b.png"], 0)).toEqual([])
	})

	// --- Mutation kills ---
	it("does not mutate the original arrays", () => {
		const current = ["a.png"]
		const newImgs = ["b.png"]
		appendImages(current, newImgs, 5)
		expect(current).toEqual(["a.png"])
		expect(newImgs).toEqual(["b.png"])
	})

	it("slices using maxImages, not a different limit (mutation: removing slice)", () => {
		const result = appendImages(["a", "b", "c"], ["d", "e", "f"], 4)
		expect(result).toHaveLength(4)
		expect(result).toEqual(["a", "b", "c", "d"])
	})
})
