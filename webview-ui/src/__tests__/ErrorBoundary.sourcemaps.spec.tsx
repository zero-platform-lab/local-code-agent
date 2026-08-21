import { createRef, type ReactNode, type RefObject } from "react"
import { render, screen, waitFor } from "@testing-library/react"

import { enhanceErrorWithSourceMaps } from "@src/utils/sourceMapUtils"

import ErrorBoundary from "../components/ErrorBoundary"

vi.mock("react-i18next", () => {
	const tFunction = (key: string) => key
	return {
		withTranslation: () => (Component: any) => {
			// `innerRef` lets a test reach the boundary instance itself to call its lifecycle
			// hooks directly; React never hands it a null component stack on its own.
			const Wrapped = ({ innerRef, ...props }: any) => (
				<Component ref={innerRef} t={tFunction} i18n={{ t: tFunction }} tReady {...props} />
			)
			Wrapped.displayName = "withTranslation(ErrorBoundary)"
			return Wrapped
		},
	}
})

vi.mock("@src/utils/sourceMapUtils", () => ({
	enhanceErrorWithSourceMaps: vi.fn(async (error: Error) => error),
}))

const Thrower = ({ thrown }: { thrown: unknown }) => {
	throw thrown
}

describe("ErrorBoundary — what it shows for different failures", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(enhanceErrorWithSourceMaps).mockImplementation(async (error: Error) => error)
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it("shows the stack of a thrown Error", async () => {
		const error = new Error("with stack")
		error.stack = "Error: with stack\n    at somewhere"

		render(
			<ErrorBoundary>
				<Thrower thrown={error} />
			</ErrorBoundary>,
		)

		expect(await screen.findByText(/at somewhere/)).toBeInTheDocument()
	})

	it("falls back to the message when the Error carries no stack", async () => {
		const error = new Error("no stack here")
		error.stack = undefined

		render(
			<ErrorBoundary>
				<Thrower thrown={error} />
			</ErrorBoundary>,
		)

		expect(await screen.findByText("no stack here")).toBeInTheDocument()
	})

	it("shows something useful even when the thrown value is not an Error", async () => {
		render(
			<ErrorBoundary>
				<Thrower thrown="plain string failure" />
			</ErrorBoundary>,
		)

		expect(await screen.findByText("plain string failure")).toBeInTheDocument()
	})

	it("prefers the source mapped stacks once they resolve", async () => {
		vi.mocked(enhanceErrorWithSourceMaps).mockImplementation(async (error: any) =>
			Object.assign(error, {
				sourceMappedStack: "mapped stack line",
				sourceMappedComponentStack: "mapped component stack line",
			}),
		)

		render(
			<ErrorBoundary>
				<Thrower thrown={new Error("boom")} />
			</ErrorBoundary>,
		)

		expect(await screen.findByText("mapped stack line")).toBeInTheDocument()
		expect(await screen.findByText("mapped component stack line")).toBeInTheDocument()
	})

	it("keeps the raw stacks when source mapping produces nothing", async () => {
		const error = new Error("boom")
		error.stack = "Error: boom\n    at raw-frame"

		render(
			<ErrorBoundary>
				<Thrower thrown={error} />
			</ErrorBoundary>,
		)

		await waitFor(() => expect(enhanceErrorWithSourceMaps).toHaveBeenCalled())
		expect(screen.getByText(/at raw-frame/)).toBeInTheDocument()
		// The component stack is only put on state by the async componentDidCatch, so the section
		// is not rendered yet at the moment enhanceErrorWithSourceMaps is *called*. Waiting on the
		// call alone raced the re-render and failed under load (parallel workers + coverage).
		expect(await screen.findByText("errorBoundary.componentStack")).toBeInTheDocument()
	})

	it("passes the component stack from React to the source mapper", async () => {
		render(
			<ErrorBoundary>
				<Thrower thrown={new Error("boom")} />
			</ErrorBoundary>,
		)

		await waitFor(() => expect(enhanceErrorWithSourceMaps).toHaveBeenCalled())
		const [, componentStack] = vi.mocked(enhanceErrorWithSourceMaps).mock.calls[0]
		expect(componentStack).toContain("Thrower")
	})

	it("reports the version as unknown when the build did not stamp one", async () => {
		vi.stubEnv("PKG_VERSION", "")

		render(
			<ErrorBoundary>
				<Thrower thrown={new Error("boom")} />
			</ErrorBoundary>,
		)

		expect(await screen.findByText(/\(vunknown\)/)).toBeInTheDocument()
	})
	it("copes with React not supplying a component stack", async () => {
		// The mocked HOC above forwards `innerRef` to the class, which the real HOC's prop types
		// know nothing about; the class itself is still the real one being exercised.
		const BoundaryWithRef = ErrorBoundary as unknown as React.FC<{
			innerRef: RefObject<any>
			children: ReactNode
		}>
		const ref = createRef<any>()

		render(
			<BoundaryWithRef innerRef={ref}>
				<div>fine</div>
			</BoundaryWithRef>,
		)

		await ref.current.componentDidCatch(new Error("boom"), { componentStack: null })

		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(expect.any(Error), "")
		await waitFor(() => expect(ref.current.state.componentStack).toBe(""))
	})
})
