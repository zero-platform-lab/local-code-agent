// npx vitest run services/pii/__tests__/nerFetch.spec.ts
//
// モデルの取得。
//
// **取れたつもりで欠けている状態を作らない**ことを確かめる。欠けたまま進むと、第 2 層が
// 静かに動かず、画面の見た目は変わらない。
//
// 本物の取得先へは行かない。ローカルにサーバを立てて、そこから取る。

import http from "node:http"
import * as os from "os"
import * as path from "path"
import type { AddressInfo } from "node:net"
import { createHash } from "crypto"
import { promises as fs } from "fs"

vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))

import { allowNetConnect } from "../../../vitest.setup"
import { CHECKSUM_FILE, REQUIRED_FILES } from "../nerModel"
import { DEFAULT_MODEL_URL, fetchModel, resolveBase } from "../nerFetch"

const body = (relative: string) => `${relative} の中身`
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** 添付を平らに並べたサーバ。`missing` に挙げたものは返さない。 */
async function startServer(missing: string[] = [], broken: string[] = []) {
	const server = http.createServer((req, res) => {
		const name = (req.url ?? "").replace(/^\//, "")

		if (name === CHECKSUM_FILE) {
			const lines = REQUIRED_FILES.map((one) => `${sha(body(one))}  ./${one}`)
			res.writeHead(200).end(lines.join("\n") + "\n")
			return
		}

		const relative = REQUIRED_FILES.find((one) => path.posix.basename(one) === name)
		if (!relative || missing.includes(relative)) {
			res.writeHead(404).end("no")
			return
		}

		res.writeHead(200).end(broken.includes(relative) ? "壊れている" : body(relative))
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
	}
}

let dir: string

beforeEach(async () => {
	allowNetConnect("127.0.0.1")
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pii-ner-fetch-"))
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

describe("fetchModel（FR-PII-23c）", () => {
	it("5 つのファイルと照合する値を揃える", async () => {
		const server = await startServer()
		try {
			const check = await fetchModel(dir, { baseUrl: server.base })

			expect(check.ok).toBe(true)
			for (const one of REQUIRED_FILES) {
				expect(await fs.readFile(path.join(dir, one), "utf8")).toBe(body(one))
			}
			expect(await fs.readFile(path.join(dir, CHECKSUM_FILE), "utf8")).toContain("./config.json")
		} finally {
			await server.close()
		}
	})

	it("入れ子の置き場所も作る", async () => {
		const server = await startServer()
		try {
			await fetchModel(dir, { baseUrl: server.base })

			// 添付は平らに並ぶので、`model_quantized.onnx` を `onnx/` の下へ置く。
			expect(await fs.readFile(path.join(dir, "onnx", "model_quantized.onnx"), "utf8")).toBeTruthy()
		} finally {
			await server.close()
		}
	})

	it("進み具合を伝える", async () => {
		const server = await startServer()
		try {
			const seen: string[] = []
			await fetchModel(dir, { baseUrl: server.base, report: (one) => seen.push(one) })

			expect(seen).toEqual([CHECKSUM_FILE, ...REQUIRED_FILES])
		} finally {
			await server.close()
		}
	})

	it("取れなければ、途中で止めて理由を言う", async () => {
		const server = await startServer(["tokenizer.json"])
		try {
			await expect(fetchModel(dir, { baseUrl: server.base })).rejects.toThrow("404")
		} finally {
			await server.close()
		}
	})

	it("取れても中身が違えば、通ったことにしない", async () => {
		// 取れたつもりで欠けている状態を作らない。
		const server = await startServer([], ["config.json"])
		try {
			const check = await fetchModel(dir, { baseUrl: server.base })

			expect(check.ok).toBe(false)
			expect(check.mismatched).toEqual(["config.json"])
		} finally {
			await server.close()
		}
	})

	it("末尾の斜線は付いていても付いていなくてもよい", async () => {
		const server = await startServer()
		try {
			expect((await fetchModel(dir, { baseUrl: `${server.base}///` })).ok).toBe(true)
		} finally {
			await server.close()
		}
	})

	it("既定の取得先は、版ごとのタグを指す", () => {
		// 拡張の版を上げるたびに 282 MB を取り直さないため、別のタグにしてある。
		expect(DEFAULT_MODEL_URL).toContain("/releases/download/model-ner-ja-")
	})
})

describe("resolveBase", () => {
	it("指定が無ければ既定の取得先を使う", () => {
		expect(resolveBase()).toBe(DEFAULT_MODEL_URL)
	})

	it("末尾の斜線を落とす", () => {
		// `.../v1/` のまま繋ぐと `//SHA256SUMS` になる。
		expect(resolveBase("https://例/v1//")).toBe("https://例/v1")
	})
})
