// npx vitest run src/debug-log/__tests__/debug-log.spec.ts
//
// debug-log は「ログの出力先の組み立て」と「ログ失敗が本体を壊さない」ことが不変条件。
// 固定するのは次の点:
//   1. **不変条件**: 出力先は必ず `<homedir>/.agent/cli-debug.log`。
//      ディレクトリが無ければ recursive で作ってから追記する
//   2. **不変条件**: 無効時（既定）は fs へ一切触れない
//   3. **不変条件**: 追記が失敗しても例外を外に投げない（ログ障害で機能を壊さない）
//
// fs / os は完全にモックし、実ファイルには一切書かない。

import * as fs from "fs"

// os.homedir() は debug-log の import 時に評価され DEBUG_LOG_PATH を決める。
// hoist される vi.mock で固定値を差し込む。
vi.mock("os", () => {
	const homedir = () => "/home/testuser"
	return { homedir, default: { homedir } }
})

// fs は appendFileSync / existsSync / mkdirSync だけ使う。全てスパイに差し替える。
vi.mock("fs", () => {
	const api = {
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn(),
	}
	return { ...api, default: api }
})

import { setDebugLogEnabled, debugLog, DebugLogger, providerDebugLog } from "../index.js"

const LOG_PATH = "/home/testuser/.agent/cli-debug.log"
const LOG_DIR = "/home/testuser/.agent"

const existsSyncMock = vi.mocked(fs.existsSync)
const mkdirSyncMock = vi.mocked(fs.mkdirSync)
const appendFileSyncMock = vi.mocked(fs.appendFileSync)

beforeEach(() => {
	vi.clearAllMocks()
	// 既定でディレクトリは存在する扱い（存在しないケースは個別に上書き）
	existsSyncMock.mockReturnValue(true)
})

afterEach(() => {
	// モジュールレベルの有効フラグはテスト間で持ち越すため必ず戻す
	setDebugLogEnabled(false)
})

describe("debugLog（有効・無効の分岐）", () => {
	it("無効（既定）のときは fs に一切触れない", () => {
		// setDebugLogEnabled(true) を呼ばない = debugLogEnabled は false のまま
		debugLog("someEvent", { a: 1 })

		expect(existsSyncMock).not.toHaveBeenCalled()
		expect(mkdirSyncMock).not.toHaveBeenCalled()
		expect(appendFileSyncMock).not.toHaveBeenCalled()
	})

	it("有効かつログディレクトリが無いときは recursive で作成してから追記する", () => {
		setDebugLogEnabled(true)
		existsSyncMock.mockReturnValue(false)

		debugLog("handleModeSwitch", { mode: "code", configId: "abc" })

		// 出力先の組み立て（不変条件）
		expect(existsSyncMock).toHaveBeenCalledWith(LOG_DIR)
		expect(mkdirSyncMock).toHaveBeenCalledWith(LOG_DIR, { recursive: true })

		expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
		const [pathArg, entryArg] = appendFileSyncMock.mock.calls[0]!
		expect(pathArg).toBe(LOG_PATH)
		const entry = entryArg as string
		expect(entry).toContain("handleModeSwitch")
		// data ありのときは JSON を連結する
		expect(entry).toContain('"mode": "code"')
		expect(entry).toContain('"configId": "abc"')
		expect(entry.endsWith("\n")).toBe(true)
	})

	it("有効かつログディレクトリが有るときは作成せず追記する / data 無しは message のみ", () => {
		setDebugLogEnabled(true)
		existsSyncMock.mockReturnValue(true)

		debugLog("bareMessage")

		expect(mkdirSyncMock).not.toHaveBeenCalled()
		expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
		const entry = appendFileSyncMock.mock.calls[0]![1] as string
		expect(entry).toContain("bareMessage")
		// data 無しは ": {json}" を含まない
		expect(entry).not.toContain("bareMessage:")
		expect(entry.endsWith("bareMessage\n")).toBe(true)
	})

	it("追記が失敗しても例外を外に投げない", () => {
		setDebugLogEnabled(true)
		appendFileSyncMock.mockImplementation(() => {
			throw new Error("disk full")
		})

		// catch で握るので throw しない
		expect(() => debugLog("willFail", { x: 1 })).not.toThrow()
	})
})

describe("setDebugLogEnabled", () => {
	it("false→true→false で追記の有無が切り替わる", () => {
		setDebugLogEnabled(false)
		debugLog("off")
		expect(appendFileSyncMock).not.toHaveBeenCalled()

		setDebugLogEnabled(true)
		debugLog("on")
		expect(appendFileSyncMock).toHaveBeenCalledTimes(1)

		setDebugLogEnabled(false)
		debugLog("offAgain")
		expect(appendFileSyncMock).toHaveBeenCalledTimes(1)
	})
})

describe("DebugLogger（コンポーネント名の前置き）", () => {
	beforeEach(() => {
		setDebugLogEnabled(true)
	})

	const lastEntry = (): string => appendFileSyncMock.mock.calls.at(-1)![1] as string

	it("debug はコンポーネント名を前置きして追記する", () => {
		const log = new DebugLogger("ClineProvider")
		log.debug("hello", { k: "v" })
		expect(lastEntry()).toContain("[ClineProvider] hello")
	})

	it("info は debug のエイリアス（同じ前置き）", () => {
		const log = new DebugLogger("Comp")
		log.info("viaInfo")
		expect(lastEntry()).toContain("[Comp] viaInfo")
	})

	it("warn は WARN: を付ける", () => {
		const log = new DebugLogger("Comp")
		log.warn("careful")
		expect(lastEntry()).toContain("[Comp] WARN: careful")
	})

	it("error は ERROR: を付ける", () => {
		const log = new DebugLogger("Comp")
		log.error("boom")
		expect(lastEntry()).toContain("[Comp] ERROR: boom")
	})

	it("providerDebugLog は ProviderSettings 名の既製ロガー", () => {
		expect(providerDebugLog).toBeInstanceOf(DebugLogger)
		providerDebugLog.debug("ready")
		expect(lastEntry()).toContain("[ProviderSettings] ready")
	})
})
