import path from "node:path"

import * as vscode from "vscode"

vi.mock("fs/promises", async () => {
	const mod = await import("../../__mocks__/fs/promises")
	return (mod as any).default ?? mod
})

describe("getStorageBasePath - customStoragePath", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns the configured custom path when it is writable", async () => {
		const customPath = "/test/storage/path"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(customPath)
		expect((fsPromises as any).mkdir).toHaveBeenCalledWith(customPath, { recursive: true })
		expect((fsPromises as any).access).toHaveBeenCalledWith(customPath, 7) // 7 = R_OK(4) | W_OK(2) | X_OK(1)
	})

	it("falls back to default and shows an error when custom path is not writable", async () => {
		const customPath = "/test/storage/unwritable"

		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		await (fsPromises as any).mkdir(customPath, { recursive: true })

		const accessMock = (fsPromises as any).access as ReturnType<typeof vi.fn>
		accessMock.mockImplementationOnce(async (p: string) => {
			if (p === customPath) {
				const err: any = new Error("EACCES: permission denied")
				err.code = "EACCES"
				throw err
			}
			return Promise.resolve()
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
		const firstArg = showErrorSpy.mock.calls[0][0]
		expect(typeof firstArg).toBe("string")
	})
	it("returns the default path when customStoragePath is an empty string and does not touch fs", async () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(""),
		} as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect((fsPromises as any).mkdir).not.toHaveBeenCalled()
		expect((fsPromises as any).access).not.toHaveBeenCalled()
	})

	it("falls back to default when mkdir fails and does not attempt access", async () => {
		const customPath = "/test/storage/failmkdir"

		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const mkdirMock = (fsPromises as any).mkdir as ReturnType<typeof vi.fn>
		mkdirMock.mockImplementationOnce(async (p: string) => {
			if (p === customPath) {
				const err: any = new Error("EACCES: permission denied")
				err.code = "EACCES"
				throw err
			}
			return Promise.resolve()
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect((fsPromises as any).access).not.toHaveBeenCalled()
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
	})

	it("passes the correct permission flags (R_OK | W_OK | X_OK) to fs.access", async () => {
		const customPath = "/test/storage/path"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		await getStorageBasePath(defaultPath)

		const constants = (fsPromises as any).constants
		const expectedFlags = constants.R_OK | constants.W_OK | constants.X_OK

		expect((fsPromises as any).access).toHaveBeenCalledWith(customPath, expectedFlags)
	})

	it("falls back when directory is readable but not writable (partial permissions)", async () => {
		const customPath = "/test/storage/readonly"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)

		const showErrorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")

		const accessMock = (fsPromises as any).access as ReturnType<typeof vi.fn>
		const constants = (fsPromises as any).constants
		accessMock.mockImplementationOnce(async (p: string, mode?: number) => {
			// Simulate readable (R_OK) but not writable/executable (W_OK | X_OK)
			if (p === customPath && mode && mode & (constants.W_OK | constants.X_OK)) {
				const err: any = new Error("EACCES: permission denied")
				err.code = "EACCES"
				throw err
			}
			return Promise.resolve()
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(showErrorSpy).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// isSafeTaskId / getTaskDirectoryPath
//
// taskId は履歴 JSON 由来の値がそのまま流れてくる。`path.join(base, "tasks", taskId)` は
// 正規化するので、空文字や ".." が入ると tasks ディレクトリ自身やその上位を指す。
// このパスは削除経路（fs.rm(recursive, force)）でも使われるため、
// 「1 セグメントとして安全な文字列以外はパスを組む前に落とす」ことを不変条件として固定する。
// ---------------------------------------------------------------------------

describe("isSafeTaskId", () => {
	const VALID_UUID = "9f3c1c2e-6b1a-4d2f-9a3b-7c5e8d0a1b2c"

	it.each([
		// [ラベル, 入力, 期待値]
		["通常の UUID", VALID_UUID, true],
		["数字だけの ID", "1712345678901", true],
		["ドットを含むが '.'/'..' ではない", "a.b.c", true],
		["先頭がドット", ".hidden", true],
		[
			// URL エンコードされた区切りは fs API から見ればただの 1 セグメントなので通す。
			// ここを弾くと「デコードされる」という誤解を仕様に持ち込むことになる。
			"URL エンコードされた区切り",
			"..%2F..",
			true,
		],
		["空白だけ", "   ", true],
		["空文字", "", false],
		["カレントディレクトリ", ".", false],
		["親ディレクトリ", "..", false],
		["POSIX の区切りを含む", "a/b", false],
		["Windows の区切りを含む", "a\\b", false],
		["相対パス", "../etc", false],
		["絶対パス", "/etc/passwd", false],
		["NUL を含む", "a\0b", false],
		["undefined", undefined, false],
		["null", null, false],
		["数値", 123, false],
		["オブジェクト", {}, false],
		["配列", [], false],
		["String オブジェクト（プリミティブではない）", new String(VALID_UUID), false],
	])("%s → %s は %s", async (_label, input, expected) => {
		const { isSafeTaskId } = await import("../storage")

		expect(isSafeTaskId(input)).toBe(expected)
	})
})

describe("getTaskDirectoryPath", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("安全な ID なら tasks/<id> を作って返す", async () => {
		const taskId = "9f3c1c2e-6b1a-4d2f-9a3b-7c5e8d0a1b2c"
		const fsPromises = await import("fs/promises")
		const { getTaskDirectoryPath } = await import("../storage")

		const result = await getTaskDirectoryPath(defaultPath, taskId)

		expect(result).toBe(path.join(defaultPath, "tasks", taskId))
		expect((fsPromises as any).mkdir).toHaveBeenCalledWith(result, { recursive: true })
	})

	it.each([
		["空文字", ""],
		["カレントディレクトリ", "."],
		["親ディレクトリ", ".."],
		["POSIX の区切りを含む", "a/b"],
		["Windows の区切りを含む", "a\\b"],
		["ストレージ外へ抜ける相対パス", "../../../../etc"],
		["絶対パス", "/etc"],
		["NUL を含む", "a\0b"],
		["undefined", undefined as unknown as string],
		["数値", 123 as unknown as string],
	])("%s は throw し、fs.mkdir を呼ばない", async (_label, taskId) => {
		const fsPromises = await import("fs/promises")
		const { getTaskDirectoryPath } = await import("../storage")

		await expect(getTaskDirectoryPath(defaultPath, taskId)).rejects.toThrow(
			/Refusing to build a task directory path for an unsafe task id/,
		)

		// mkdir が 1 回でも走ると、そのディレクトリを消しに行く経路が生まれる。
		expect((fsPromises as any).mkdir).not.toHaveBeenCalled()
	})

	it("不正な ID の検査はカスタムストレージパスの解決より前に行う（設定を読みに行かない）", async () => {
		// 先に getStorageBasePath を通すと、mkdir/access という副作用が
		// 「弾くはずの入力」でも走ってしまう。順序そのものを固定する。
		const getConfigurationSpy = vi.spyOn(vscode.workspace, "getConfiguration")
		const fsPromises = await import("fs/promises")
		const { getTaskDirectoryPath } = await import("../storage")

		await expect(getTaskDirectoryPath(defaultPath, "../..")).rejects.toThrow(/unsafe task id/)

		expect(getConfigurationSpy).not.toHaveBeenCalled()
		expect((fsPromises as any).access).not.toHaveBeenCalled()
		getConfigurationSpy.mockRestore()
	})

	it("throw されるメッセージには問題の ID が引用符付きで載る", async () => {
		const { getTaskDirectoryPath } = await import("../storage")

		await expect(getTaskDirectoryPath(defaultPath, "../..")).rejects.toThrow('"../.."')
	})
})

// ---------------------------------------------------------------------------
// getSettingsDirectoryPath / getCacheDirectoryPath
// ---------------------------------------------------------------------------
describe("settings / cache directory paths", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(""),
		} as any)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("getSettingsDirectoryPath は <base>/settings を作って返す", async () => {
		const fsPromises = await import("fs/promises")
		const { getSettingsDirectoryPath } = await import("../storage")

		const result = await getSettingsDirectoryPath(defaultPath)

		expect(result).toBe(path.join(defaultPath, "settings"))
		expect((fsPromises as any).mkdir).toHaveBeenCalledWith(result, { recursive: true })
	})

	it("getCacheDirectoryPath は <base>/cache を作って返す", async () => {
		const fsPromises = await import("fs/promises")
		const { getCacheDirectoryPath } = await import("../storage")

		const result = await getCacheDirectoryPath(defaultPath)

		expect(result).toBe(path.join(defaultPath, "cache"))
		expect((fsPromises as any).mkdir).toHaveBeenCalledWith(result, { recursive: true })
	})
})

// getStorageBasePath: Error 以外で reject しても String(error) で整形する分岐。
describe("getStorageBasePath - non-Error rejection", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it("getConfiguration 自体が投げたら警告して既定パスを返す", async () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(() => {
			throw new Error("configuration unavailable")
		})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const { getStorageBasePath } = await import("../storage")
		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(warnSpy).toHaveBeenCalled()
	})

	it("access が Error 以外で reject しても String(error) にして既定へ落ちる", async () => {
		const customPath = "/test/storage/weird"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn().mockReturnValue(customPath),
		} as any)
		vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const fsPromises = await import("fs/promises")
		const { getStorageBasePath } = await import("../storage")
		;(fsPromises as any).access.mockImplementationOnce(async () => {
			throw "plain string error" // Error インスタンスではない
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("plain string error"))
	})
})

// ---------------------------------------------------------------------------
// promptForCustomStoragePath
// ---------------------------------------------------------------------------
describe("promptForCustomStoragePath", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function mockConfig(currentPath: string, update = vi.fn().mockResolvedValue(undefined)) {
		const get = vi.fn().mockReturnValue(currentPath)
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ get, update } as any)
		return { get, update }
	}

	it("有効な絶対パスを入力すると設定を更新し成功メッセージを出す（validateInput の各分岐も検証）", async () => {
		const { update } = mockConfig("/test/old")
		const infoSpy = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as any)

		let captured: any
		const inputSpy = vi.spyOn(vscode.window, "showInputBox").mockImplementation(async (opts: any) => {
			captured = opts
			// validateInput の各分岐を直接検証する。
			expect(opts.validateInput("")).toBeNull() // 空は許可（既定パス）
			expect(opts.validateInput("/abs/ok")).toBeNull() // 絶対パスは OK
			expect(typeof opts.validateInput("relative")).toBe("string") // 相対はエラー文言
			expect(typeof opts.validateInput(123 as any)).toBe("string") // path.parse 例外 → エラー文言
			return "/test/custom-new"
		})

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(inputSpy).toHaveBeenCalledTimes(1)
		expect(captured.value).toBe("/test/old")
		expect(update).toHaveBeenCalledWith("customStoragePath", "/test/custom-new", vscode.ConfigurationTarget.Global)
		expect(infoSpy).toHaveBeenCalledTimes(1)
	})

	it("空文字を確定すると既定パスの案内メッセージを出す", async () => {
		const { update } = mockConfig("/test/old")
		const infoSpy = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as any)
		vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("" as any)

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(update).toHaveBeenCalledWith("customStoragePath", "", vscode.ConfigurationTarget.Global)
		expect(infoSpy).toHaveBeenCalledTimes(1)
	})

	it("mkdir/access が Error で失敗するとアクセス不可メッセージを出す", async () => {
		mockConfig("")
		const errorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)
		vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("/test/target" as any)

		const fsPromises = await import("fs/promises")
		;(fsPromises as any).mkdir.mockImplementationOnce(async () => {
			const err: any = new Error("EACCES")
			err.code = "EACCES"
			throw err
		})

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("mkdir/access が Error 以外で失敗しても String(error) で整形して案内する", async () => {
		mockConfig("")
		const errorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)
		vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("/test/target2" as any)

		const fsPromises = await import("fs/promises")
		;(fsPromises as any).mkdir.mockImplementationOnce(async () => {
			throw "string failure" // Error インスタンスではない
		})

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("入力がキャンセル（undefined）なら設定更新もメッセージも出さない", async () => {
		const { update } = mockConfig("/test/old")
		const infoSpy = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as any)
		const errorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as any)
		vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined as any)

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(update).not.toHaveBeenCalled()
		expect(infoSpy).not.toHaveBeenCalled()
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("設定更新が失敗しても例外を投げずログするだけ", async () => {
		const update = vi.fn().mockRejectedValue(new Error("update fail"))
		mockConfig("/test/old", update)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("/test/target3" as any)

		const { promptForCustomStoragePath } = await import("../storage")
		await expect(promptForCustomStoragePath()).resolves.toBeUndefined()

		expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to update configuration", expect.any(Error))
	})

	it("現在の設定取得が失敗したら showInputBox を出さずに戻る", async () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: vi.fn(() => {
				throw new Error("no config")
			}),
		} as any)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const inputSpy = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined as any)

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		expect(inputSpy).not.toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith("Could not access configuration")
	})

	it("VS Code API が使えない場合は早期 return する", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const inputSpy = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined as any)

		// window を一時的に落として !vscode.window 分岐へ入れる。
		// 名前空間は読み取り専用なので getter を差し替える。
		const windowSpy = vi.spyOn(vscode, "window", "get").mockReturnValue(undefined as any)

		const { promptForCustomStoragePath } = await import("../storage")
		await promptForCustomStoragePath()

		windowSpy.mockRestore()

		expect(inputSpy).not.toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith("VS Code API not available")
	})
})
