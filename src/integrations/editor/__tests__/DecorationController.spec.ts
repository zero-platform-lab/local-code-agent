// npx vitest run integrations/editor/__tests__/DecorationController.spec.ts

import * as vscode from "vscode"

import { DecorationController } from "../DecorationController"

// VSCode の Range/Position の必要最小限の振る舞いを再現するモック。
// DecorationController は Range の 4 引数コンストラクタ・Position・
// translate()/with() を使うため、素の __mocks__/vscode.js では足りない。
vi.mock("vscode", () => {
	class MockPosition {
		constructor(
			public line: number,
			public character: number,
		) {}
		translate(lineDelta = 0, characterDelta = 0) {
			return new MockPosition(this.line + lineDelta, this.character + characterDelta)
		}
	}

	class MockRange {
		start: MockPosition
		end: MockPosition
		constructor(a: MockPosition | number, b: MockPosition | number, c?: number, d?: number) {
			if (typeof a === "object") {
				this.start = a
				this.end = b as MockPosition
			} else {
				this.start = new MockPosition(a, b as number)
				this.end = new MockPosition(c as number, d as number)
			}
		}
		with(start?: MockPosition, end?: MockPosition) {
			return new MockRange(start ?? this.start, end ?? this.end)
		}
	}

	// 装飾タイプは「同一性が保てるだけ」の番兵で十分。
	const faded = { id: "fadedOverlay" }
	const active = { id: "activeLine" }
	let createCount = 0

	return {
		Position: MockPosition,
		Range: MockRange,
		window: {
			createTextEditorDecorationType: vi.fn(() => (createCount++ === 0 ? faded : active)),
		},
		// テストから同一性を照合できるよう露出させておく。
		__decorations: { faded, active },
	}
})

type MockEditor = { setDecorations: ReturnType<typeof vi.fn> }

function makeEditor(): MockEditor {
	return { setDecorations: vi.fn() }
}

// getDecoration() の戻り値（装飾タイプの番兵）を取り出すヘルパ。
const decorations = (vscode as unknown as { __decorations: { faded: unknown; active: unknown } }).__decorations

beforeEach(() => {
	vi.clearAllMocks()
})

describe("DecorationController.getDecoration", () => {
	it("fadedOverlay タイプでは faded の装飾を返す", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		// clear() 経由で getDecoration() を呼ばせる。
		controller.clear()
		expect(editor.setDecorations).toHaveBeenCalledWith(decorations.faded, [])
	})

	it("activeLine タイプでは active の装飾を返す", () => {
		const editor = makeEditor()
		const controller = new DecorationController("activeLine", editor as unknown as vscode.TextEditor)
		controller.clear()
		expect(editor.setDecorations).toHaveBeenCalledWith(decorations.active, [])
	})
})

describe("DecorationController.addLines", () => {
	it("startIndex が負なら何もしない（左オペランドの guard）", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(-1, 5)
		expect(editor.setDecorations).not.toHaveBeenCalled()
	})

	it("numLines が 0 以下なら何もしない（右オペランドの guard）", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(0, 0)
		expect(editor.setDecorations).not.toHaveBeenCalled()
	})

	it("最初の範囲を push する", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(5, 2)
		const ranges = editor.setDecorations.mock.calls[0][1] as vscode.Range[]
		expect(ranges).toHaveLength(1)
		expect(ranges[0].start.line).toBe(5)
		expect(ranges[0].end.line).toBe(6) // 5 + 2 - 1
	})

	it("直前の範囲と連続していれば末尾を延長してマージする", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(5, 2) // -> end.line = 6
		controller.addLines(7, 3) // startIndex-1 === 6 なのでマージ
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		expect(ranges).toHaveLength(1)
		expect(ranges[0].end.line).toBe(9) // 6 + 3
	})

	it("連続していなければ新しい範囲を push する", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(5, 2) // -> end.line = 6
		controller.addLines(20, 1) // startIndex-1 === 19 !== 6 なので別範囲
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		expect(ranges).toHaveLength(2)
		expect(ranges[1].start.line).toBe(20)
	})
})

describe("DecorationController.clear", () => {
	it("範囲を空にして装飾を消す", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.addLines(1, 1)
		controller.clear()
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		expect(ranges).toHaveLength(0)
	})
})

describe("DecorationController.updateOverlayAfterLine", () => {
	it("line より後ろに残り行があれば新しい範囲を追加する（true 分岐）", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		// 先に line 0 で終わる範囲を作っておき、filter が残すことを確認。
		controller.addLines(0, 1) // end.line = 0
		controller.updateOverlayAfterLine(2, 10)
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		// end.line(0) < line(2) の既存範囲は残り、後半用の新範囲が 1 つ足される。
		expect(ranges).toHaveLength(2)
		expect(ranges[1].start.line).toBe(3) // line + 1
		expect(ranges[1].end.line).toBe(9) // totalLines - 1
	})

	it("line が末尾付近なら新しい範囲を追加しない（false 分岐）", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor as unknown as vscode.TextEditor)
		controller.setActiveLine(9) // end.line = 9 -> filter(9 < 9) で除外される
		controller.updateOverlayAfterLine(9, 10) // 9 < 9 は false なので push しない
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		expect(ranges).toHaveLength(0)
	})
})

describe("DecorationController.setActiveLine", () => {
	it("単一行の範囲だけにする", () => {
		const editor = makeEditor()
		const controller = new DecorationController("activeLine", editor as unknown as vscode.TextEditor)
		controller.setActiveLine(3)
		const ranges = editor.setDecorations.mock.calls.at(-1)![1] as vscode.Range[]
		expect(ranges).toHaveLength(1)
		expect(ranges[0].start.line).toBe(3)
		expect(ranges[0].end.line).toBe(3)
	})
})
