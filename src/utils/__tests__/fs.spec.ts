import { createDirectoriesForFile, fileExistsAtPath } from "../fs"

// fs/promises を丸ごとモックし、mkdir / access の挙動をテストごとに制御する。
// 本物のディスクには触れない。
vi.mock("fs/promises", () => ({
	default: {
		mkdir: vi.fn(),
		access: vi.fn(),
	},
}))

import fs from "fs/promises"

const mkdirMock = fs.mkdir as unknown as ReturnType<typeof vi.fn>
const accessMock = fs.access as unknown as ReturnType<typeof vi.fn>

/**
 * access を「存在するパスの集合」で駆動するヘルパ。
 * 集合に無いパスは ENOENT で reject（＝存在しない）。
 */
function existingPaths(set: Set<string>) {
	accessMock.mockImplementation(async (p: string) => {
		if (set.has(p)) {
			return undefined
		}
		const err: any = new Error(`ENOENT: no such file or directory, access '${p}'`)
		err.code = "ENOENT"
		throw err
	})
}

describe("fileExistsAtPath", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("access が解決すれば true", async () => {
		accessMock.mockResolvedValue(undefined)
		await expect(fileExistsAtPath("/some/where")).resolves.toBe(true)
		expect(accessMock).toHaveBeenCalledWith("/some/where")
	})

	it("access が reject すれば false（例外を飲み込む）", async () => {
		accessMock.mockRejectedValue(new Error("ENOENT"))
		await expect(fileExistsAtPath("/missing")).resolves.toBe(false)
	})
})

describe("createDirectoriesForFile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mkdirMock.mockResolvedValue(undefined)
	})

	it("親ディレクトリが全て存在するなら何も作らず空配列を返す", async () => {
		// dirname が最初の fileExistsAtPath で true になる。
		existingPaths(new Set(["/a/b/c"]))

		const created = await createDirectoriesForFile("/a/b/c/file.txt")

		expect(created).toEqual([])
		expect(mkdirMock).not.toHaveBeenCalled()
	})

	it("欠けている分だけを最上位→最下位の順に作り、作成した配列を返す（ロールバック用リスト）", async () => {
		// /a は存在、/a/b と /a/b/c は無い。
		existingPaths(new Set(["/a"]))

		const created = await createDirectoriesForFile("/a/b/c/file.txt")

		// 返り値は「新規に作ったディレクトリ」= 呼び出し側が後で消せるロールバック用リスト。
		// 作成順は最上位から。既存の /a は含めない。
		expect(created).toEqual(["/a/b", "/a/b/c"])

		// mkdir は各ディレクトリに 1 回ずつ、recursive を付けずに呼ぶ（1 段ずつ作る設計）。
		expect(mkdirMock).toHaveBeenNthCalledWith(1, "/a/b")
		expect(mkdirMock).toHaveBeenNthCalledWith(2, "/a/b/c")
		expect(mkdirMock).toHaveBeenCalledTimes(2)
	})

	it("既存ディレクトリは作り直さない（返り値に含めない）", async () => {
		// /a/b までは存在、/a/b/c だけ無い。
		existingPaths(new Set(["/a", "/a/b"]))

		const created = await createDirectoriesForFile("/a/b/c/file.txt")

		expect(created).toEqual(["/a/b/c"])
		expect(mkdirMock).toHaveBeenCalledTimes(1)
		expect(mkdirMock).toHaveBeenCalledWith("/a/b/c")
	})

	it("パスは正規化してから dirname を取る（末尾の余計な区切りに依存しない）", async () => {
		existingPaths(new Set(["/a/b/c"]))

		// 正規化しないと dirname が "/a/b/c/." のようになり得るが、
		// path.normalize を通すので "/a/b/c" として扱われる。
		const created = await createDirectoriesForFile("/a/b/c/./file.txt")

		expect(created).toEqual([])
		expect(mkdirMock).not.toHaveBeenCalled()
	})

	it("mkdir が途中で失敗したら例外を投げる（作成途中の状態でも throw する）", async () => {
		existingPaths(new Set(["/a"]))
		// 最初の mkdir(/a/b) は成功、次の mkdir(/a/b/c) で失敗させる。
		mkdirMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("EACCES"))

		await expect(createDirectoriesForFile("/a/b/c/file.txt")).rejects.toThrow("EACCES")
		// 失敗時点までに /a/b は作られている（呼び出しは行われた）。
		expect(mkdirMock).toHaveBeenNthCalledWith(1, "/a/b")
		expect(mkdirMock).toHaveBeenNthCalledWith(2, "/a/b/c")
	})
})
