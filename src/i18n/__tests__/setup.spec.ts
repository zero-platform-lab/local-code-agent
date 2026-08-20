// npx vitest run i18n/__tests__/setup.spec.ts
//
// setup.ts は import 時に「ロケールを fs から読み込んで i18next を init する」副作用モジュール。
// テスト環境（NODE_ENV=test）では fs を触らず in-memory バンドルだけで init する分岐が既定。
// ここでは NODE_ENV を外して本番相当の読み込みパスを網羅し、欠損ロケール・壊れた JSON・
// ディレクトリ読み込み失敗のいずれでも落ちない（例外を外へ出さず init まで到達する）ことを固定する。
//
// setup.ts はロケール読み込みを「意図的に動的 require」しているため vi.mock("fs") では差し替わらない
// （require は Node のビルトイン singleton を返す）。そこで同じ singleton へ spy を張って制御する。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const realFs = require("fs") as {
	readdirSync: (...args: unknown[]) => unknown
	readFileSync: (...args: unknown[]) => unknown
}
const realPath = require("path") as { join: (...segs: string[]) => string }

const m = vi.hoisted(() => ({ init: vi.fn((_opts: unknown) => undefined) }))

vi.mock("i18next", () => ({ default: { init: m.init } }))

// dirent ヘルパ
const dir = (name: string) => ({ isDirectory: () => true, isFile: () => false, name })
const notDir = (name: string) => ({ isDirectory: () => false, isFile: () => false, name })
const jsonFile = (name: string) => ({ isFile: () => true, isDirectory: () => false, name })
const notFile = (name: string) => ({ isFile: () => false, isDirectory: () => true, name })

const originalNodeEnv = process.env.NODE_ENV
let readdirSpy: ReturnType<typeof vi.spyOn>
let readFileSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	vi.resetModules()
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	readdirSpy = vi.spyOn(realFs, "readdirSync").mockReturnValue([] as never)
	readFileSpy = vi.spyOn(realFs, "readFileSync").mockReturnValue("{}" as never)
})

afterEach(() => {
	process.env.NODE_ENV = originalNodeEnv
	vi.restoreAllMocks()
})

async function loadSetup() {
	return import("../setup")
}

describe("setup.ts - テスト環境（既定）", () => {
	it("NODE_ENV=test では fs を触らず、空 resources で init する", async () => {
		process.env.NODE_ENV = "test"

		const mod = await loadSetup()

		expect(readdirSpy).not.toHaveBeenCalled()
		expect(m.init).toHaveBeenCalledTimes(1)
		const opts = m.init.mock.calls[0][0] as { lng: string; fallbackLng: string; resources: unknown }
		expect(opts.lng).toBe("ja")
		expect(opts.fallbackLng).toBe("ja")
		expect(opts.resources).toEqual({})
		expect(mod.default).toBeDefined()
	})
})

describe("setup.ts - 本番相当のロケール読み込み", () => {
	beforeEach(() => {
		process.env.NODE_ENV = "development"
	})

	it("言語ディレクトリと JSON 名前空間を読み込み、resources に載せて init する", async () => {
		// localesDir 直下は言語ディレクトリ、各言語配下は名前空間 JSON を返す。
		// ドット始まり/非ディレクトリ/非 JSON は除外されることも同時に確認する。
		readdirSpy.mockImplementation((p: unknown) => {
			if (String(p).endsWith("locales")) {
				return [dir("en"), dir("ja"), notDir("readme.txt"), dir(".hidden")] as never
			}
			return [
				jsonFile("common.json"),
				notFile("subdir"),
				jsonFile("notes.txt"),
				jsonFile(".secret.json"),
			] as never
		})
		readFileSpy.mockImplementation((fp: unknown) => {
			if (String(fp).endsWith("en/common.json")) return JSON.stringify({ hello: "Hello" }) as never
			return JSON.stringify({ hello: "こんにちは" }) as never
		})

		await loadSetup()

		const opts = m.init.mock.calls[0][0] as { resources: Record<string, Record<string, unknown>> }
		expect(Object.keys(opts.resources).sort()).toEqual(["en", "ja"])
		expect(opts.resources.en).toEqual({ common: { hello: "Hello" } })
		expect(opts.resources.ja).toEqual({ common: { hello: "こんにちは" } })
		// notes.txt / .secret.json / subdir は名前空間に載らない
		expect(Object.keys(opts.resources.en)).toEqual(["common"])
	})

	it("同名の言語ディレクトリが二度現れても再初期化せず落ちない（欠損ガードの false 側）", async () => {
		readdirSpy.mockImplementation((p: unknown) => {
			if (String(p).endsWith("locales")) return [dir("en"), dir("en")] as never
			return [jsonFile("common.json")] as never
		})
		readFileSpy.mockReturnValue(JSON.stringify({ k: "v" }) as never)

		await loadSetup()

		expect(m.init).toHaveBeenCalledTimes(1)
		const opts = m.init.mock.calls[0][0] as { resources: Record<string, unknown> }
		expect(opts.resources.en).toEqual({ common: { k: "v" } })
	})

	it("壊れた JSON はその名前空間だけ諦め、他は読み込んで init する", async () => {
		readdirSpy.mockImplementation((p: unknown) => {
			if (String(p).endsWith("locales")) return [dir("en")] as never
			return [jsonFile("broken.json"), jsonFile("common.json")] as never
		})
		readFileSpy.mockImplementation((fp: unknown) => {
			if (String(fp).endsWith("broken.json")) return "{ not valid json" as never
			return JSON.stringify({ ok: true }) as never
		})

		await loadSetup()

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Error loading translation file"),
			expect.anything(),
		)
		const opts = m.init.mock.calls[0][0] as { resources: Record<string, Record<string, unknown>> }
		// broken は載らず common だけ載る
		expect(opts.resources.en).toEqual({ common: { ok: true } })
		// 壊れていても init 自体は必ず呼ぶ
		expect(m.init).toHaveBeenCalledTimes(1)
	})

	it("ロケールディレクトリの読み込みに失敗しても init まで到達する", async () => {
		readdirSpy.mockImplementation(() => {
			throw new Error("ENOENT: locales")
		})

		await loadSetup()

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Error processing directory"),
			expect.anything(),
		)
		expect(m.init).toHaveBeenCalledTimes(1)
	})

	it("fs/path 準備段階（path.join）で失敗しても外側の catch で握って init する", async () => {
		// localesDir 計算（末尾が i18n/locales）のときだけ投げる。vitest 内部の path.join は素通しする。
		const originalJoin = realPath.join.bind(realPath)
		vi.spyOn(realPath, "join").mockImplementation((...segs: string[]) => {
			if (segs[segs.length - 1] === "locales" && segs[segs.length - 2] === "i18n") {
				throw new Error("path boom")
			}
			return originalJoin(...segs)
		})

		await loadSetup()

		expect(console.error).toHaveBeenCalledWith("Error loading translations:", expect.anything())
		expect(readdirSpy).not.toHaveBeenCalled()
		expect(m.init).toHaveBeenCalledTimes(1)
	})
})
