import { render } from "@/utils/test-utils"

import { loadTranslations } from "../setup"

import TranslationProvider, { useAppTranslation } from "../TranslationContext"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		language: "en",
	}),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		i18n: {
			t: (key: string, options?: Record<string, any>) => {
				// Mock specific translations used in tests
				if (key === "settings.autoApprove.title") return "Auto-Approve"
				if (key === "notifications.error") {
					return options?.message ? `Operation failed: ${options.message}` : "Operation failed"
				}
				return key
			},
			changeLanguage: vi.fn(),
		},
	}),
}))

vi.mock("../setup", () => ({
	default: {
		t: (key: string, options?: Record<string, any>) => {
			// Mock specific translations used in tests
			if (key === "settings.autoApprove.title") return "Auto-Approve"
			if (key === "notifications.error") {
				return options?.message ? `Operation failed: ${options.message}` : "Operation failed"
			}
			return key
		},
		changeLanguage: vi.fn(),
	},
	loadTranslations: vi.fn(),
}))

const TestComponent = () => {
	const { t } = useAppTranslation()
	return (
		<div>
			<h1 data-testid="translation-test">{t("settings.autoApprove.title")}</h1>
			<p data-testid="translation-interpolation">{t("notifications.error", { message: "Test error" })}</p>
		</div>
	)
}

describe("TranslationContext", () => {
	it("should provide translations via context", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		// Check if translation is provided correctly
		expect(getByTestId("translation-test")).toHaveTextContent("Auto-Approve")
	})

	it("should handle interpolation correctly", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		// Check if interpolation works
		expect(getByTestId("translation-interpolation")).toHaveTextContent("Operation failed: Test error")
	})
	it("loads the bundled translations once when mounted", () => {
		vi.mocked(loadTranslations).mockClear()

		render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		expect(loadTranslations).toHaveBeenCalledTimes(1)
	})

	it("still renders when the translations cannot be loaded", () => {
		// A broken locale bundle must degrade to untranslated keys, not a blank webview.
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(loadTranslations).mockImplementationOnce(() => {
			throw new Error("broken bundle")
		})

		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		expect(getByTestId("translation-test")).toBeInTheDocument()
		expect(error).toHaveBeenCalledWith("Failed to load translations:", expect.any(Error))

		error.mockRestore()
	})
	it("falls back to the raw key when used outside the provider", () => {
		// A component rendered outside TranslationProvider must still render text, not crash.
		const { getByTestId } = render(<TestComponent />)

		expect(getByTestId("translation-test")).toHaveTextContent("settings.autoApprove.title")
	})
})
