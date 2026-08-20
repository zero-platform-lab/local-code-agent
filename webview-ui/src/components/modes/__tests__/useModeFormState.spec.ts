// npx vitest src/components/modes/__tests__/useModeFormState.spec.ts

import { renderHook, act } from "@/utils/test-utils"

import { availableGroups, emptyFieldErrors } from "../modeFormLogic"
import { useModeFormState } from "../useModeFormState"

describe("useModeFormState", () => {
	it("空の下書きとエラー無しで始まる", () => {
		const { result } = renderHook(() => useModeFormState())

		expect(result.current.draft).toEqual({
			name: "",
			slug: "",
			description: "",
			roleDefinition: "",
			whenToUse: "",
			customInstructions: "",
			groups: availableGroups,
			source: "global",
		})
		expect(result.current.errors).toEqual(emptyFieldErrors)
	})

	it("setField は 1 フィールドだけ変える", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => result.current.setField("name", "My Mode"))

		expect(result.current.draft.name).toBe("My Mode")
		expect(result.current.draft.slug).toBe("")
	})

	it("patch は複数フィールドをまとめて変える", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => result.current.patch({ name: "My Mode", slug: "my-mode" }))

		expect(result.current.draft).toMatchObject({ name: "My Mode", slug: "my-mode" })
	})

	it("連続した setField が互いを打ち消さない", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => {
			result.current.setField("name", "A")
			result.current.setField("slug", "b")
		})

		expect(result.current.draft).toMatchObject({ name: "A", slug: "b" })
	})

	it("エラーを載せられる", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => result.current.setErrors({ ...emptyFieldErrors, name: "Name is required" }))

		expect(result.current.errors.name).toBe("Name is required")
	})

	it("reset は下書きとエラーを同時に初期化する（リセット漏れが起きない）", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => {
			result.current.patch({ name: "My Mode", slug: "my-mode", source: "project", groups: [] })
			result.current.setErrors({ ...emptyFieldErrors, slug: "bad" })
		})

		act(() => result.current.reset())

		expect(result.current.draft.name).toBe("")
		expect(result.current.draft.source).toBe("global")
		expect(result.current.draft.groups).toEqual(availableGroups)
		expect(result.current.errors).toEqual(emptyFieldErrors)
	})

	it("reset 後の groups は既定値の別インスタンスを共有しない", () => {
		const { result } = renderHook(() => useModeFormState())

		act(() => result.current.setField("groups", [...result.current.draft.groups, "browser" as never]))
		act(() => result.current.reset())

		expect(result.current.draft.groups).toEqual(availableGroups)
	})
})
