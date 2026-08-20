import { render, screen, fireEvent } from "@/utils/test-utils"

import { QueuedMessages } from "../QueuedMessages"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../Mention", () => ({
	Mention: ({ text }: { text: string }) => <span data-testid="mention">{text}</span>,
}))

vi.mock("@src/components/common/Thumbnails", () => ({
	default: ({ images }: { images: string[] }) => <div data-testid="thumbnails">{images.length}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => (
		<button data-testid="remove" onClick={onClick}>
			{children}
		</button>
	),
}))

const makeQueue = (over: Partial<{ id: string; text: string; images: string[] }>[] = []) =>
	over.map((o, i) => ({ id: o.id ?? `m${i}`, text: o.text ?? `msg ${i}`, images: o.images })) as any

describe("QueuedMessages", () => {
	const onRemove = vi.fn()
	const onUpdate = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when the queue is empty", () => {
		const { container } = render(<QueuedMessages queue={[]} onRemove={onRemove} onUpdate={onUpdate} />)
		expect(container.firstChild).toBeNull()
	})

	it("renders each queued message via Mention and its thumbnails when present", () => {
		render(
			<QueuedMessages
				queue={makeQueue([{ text: "hello" }, { text: "world", images: ["a", "b"] }])}
				onRemove={onRemove}
				onUpdate={onUpdate}
			/>,
		)
		expect(screen.getByText("hello")).toBeInTheDocument()
		expect(screen.getByText("world")).toBeInTheDocument()
		// 2件目のみ画像あり
		expect(screen.getAllByTestId("thumbnails")).toHaveLength(1)
		expect(screen.getByTestId("thumbnails")).toHaveTextContent("2")
	})

	it("calls onRemove with the message index (and stops propagation) on trash click", () => {
		render(
			<QueuedMessages
				queue={makeQueue([{ text: "a" }, { text: "b" }])}
				onRemove={onRemove}
				onUpdate={onUpdate}
			/>,
		)
		fireEvent.click(screen.getAllByTestId("remove")[1])
		expect(onRemove).toHaveBeenCalledWith(1)
	})

	it("enters edit mode on click and saves on blur via onUpdate", () => {
		render(
			<QueuedMessages queue={makeQueue([{ id: "x", text: "orig" }])} onRemove={onRemove} onUpdate={onUpdate} />,
		)
		fireEvent.click(screen.getByText("orig"))
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "edited" } })
		fireEvent.blur(textarea)
		expect(onUpdate).toHaveBeenCalledWith(0, "edited")
		// 保存後は編集モードを抜ける
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("saves on Enter (without shift) and cancels on Escape", () => {
		render(
			<QueuedMessages queue={makeQueue([{ id: "x", text: "orig" }])} onRemove={onRemove} onUpdate={onUpdate} />,
		)
		fireEvent.click(screen.getByText("orig"))
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement

		// Shift+Enter は保存しない
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })
		expect(onUpdate).not.toHaveBeenCalled()

		fireEvent.change(textarea, { target: { value: "via-enter" } })
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
		expect(onUpdate).toHaveBeenCalledWith(0, "via-enter")
	})

	it("Escape exits edit mode without saving", () => {
		render(
			<QueuedMessages queue={makeQueue([{ id: "x", text: "orig" }])} onRemove={onRemove} onUpdate={onUpdate} />,
		)
		fireEvent.click(screen.getByText("orig"))
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "discard" } })
		fireEvent.keyDown(textarea, { key: "Escape" })
		expect(onUpdate).not.toHaveBeenCalled()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})
})
