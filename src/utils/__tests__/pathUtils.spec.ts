// npx vitest run utils/__tests__/pathUtils.spec.ts
//
// isSafePathSegment は「外部由来の識別子を path.join に埋め込む前の唯一の防波堤」。
// ここを通った値は `path.join(base, `rules-${value}`)` や `path.join(base, "tasks", value)` の
// 形で使われ、その先には fs.rm(recursive, force) が飛ぶ。セパレータや `..` が 1 つ抜けると
// 消えるのはフォルダ 1 つでは済まず、消えたことに気づく手段も戻す手段も無い。
//
// そのため「どんな文字列を通すか」ではなく「1 セグメントから出られる値を 1 つも通さないか」を固定する。
//
// isPathInside は「解決後のパスが、許した範囲の中に収まっているか」を見る側の防波堤。
// mention 展開（cwd の外を読まない）と一時ディレクトリの削除（os.tmpdir() の外を消さない）が
// これに乗っている。ここが緩むと「読めてはいけないファイルが読める」「消してはいけない
// ディレクトリが消える」に直結するので、`..` の解決とセパレータ境界を表で固定する。

import * as path from "path"

import { describe, it, expect, afterEach } from "vitest"
import * as vscode from "vscode"

import { isPathInside, isSafePathSegment, isPathOutsideWorkspace } from "../pathUtils"

describe("isSafePathSegment", () => {
	it.each([
		// [ラベル, 入力, 期待値]
		// --- 通すもの: path.join に入れても 1 セグメントのままである値 ---
		["英数字とハイフンの slug", "my-mode", true],
		["1 文字", "a", true],
		["大文字と数字", "MODE-42", true],
		["ハイフンだけ", "----", true],
		["UUID", "9f3c1c2e-6b1a-4d2f-9a3b-7c5e8d0a1b2c", true],
		["数字だけ", "1712345678901", true],
		["ドットを含むが '.'/'..' ではない", "a.b.c", true],
		["先頭がドット", ".hidden", true],
		["末尾がドット", "trailing.", true],
		["ドット 3 つ", "...", true],
		// URL エンコードされた区切りは fs API から見ればただの 1 セグメント。
		// ここを弾くと「どこかでデコードされる」という誤解を仕様に持ち込むことになる。
		["URL エンコードされた区切り", "..%2F..", true],
		["空白だけ", "   ", true],
		["日本語", "モード", true],

		// --- 弾くもの: path.join で 1 セグメントから出る／パス API が壊れる値 ---
		// 空文字は `path.join(base, "")` が base 自身になる（接頭辞付きでも `rules-` を指す）。
		["空文字", "", false],
		["カレントディレクトリ", ".", false],
		["親ディレクトリ", "..", false],
		["POSIX の区切りを含む", "a/b", false],
		["Windows の区切りを含む", "a\\b", false],
		["先頭が POSIX の区切り", "/etc", false],
		["先頭が Windows の区切り", "\\etc", false],
		["末尾が区切り", "a/", false],
		["相対パスで親へ抜ける", "../etc", false],
		["絶対パス", "/etc/passwd", false],
		["区切りだけ", "/", false],
		["NUL を含む", "a\0b", false],
		["NUL だけ", "\0", false],

		// --- 非 string: typeof で落とす（`.length` や正規表現に届かせない） ---
		["undefined", undefined, false],
		["null", null, false],
		["数値", 123, false],
		["真偽値", true, false],
		["オブジェクト", {}, false],
		["配列", [], false],
		["空でない配列（join で文字列化されうる）", ["a"], false],
		["String オブジェクト（プリミティブではない）", new String("my-mode"), false],
	])("%s → %j は %s", (_label, input, expected) => {
		expect(isSafePathSegment(input)).toBe(expected)
	})

	it("型ガードとして string へ絞り込む", () => {
		const value: unknown = "my-mode"

		if (!isSafePathSegment(value)) {
			throw new Error("safe な値が弾かれた")
		}

		// ここで value が string でなければ tsc が落ちる（テストの主張は型そのもの）。
		expect(value.toUpperCase()).toBe("MY-MODE")
	})
})

// ---------------------------------------------------------------------------

/**
 * POSIX 記法のテスト用パスを実行環境のセパレータへ直す。
 * 正規化はしない（`..` を解決するのは isPathInside 側の仕事で、それ自体が検証対象）。
 */
function toNative(posixPath: string): string {
	return posixPath.split("/").join(path.sep)
}

/** ファイルシステムのルート（POSIX なら "/"、Windows なら "C:\\"）。末尾はセパレータ。 */
const ROOT = path.parse(path.resolve(path.sep)).root

describe("isPathInside", () => {
	it.each([
		// [ラベル, parent, child, 期待値]

		// --- 中に収まっているもの ---
		["同一パス", toNative("/a/b"), toNative("/a/b"), true],
		["直下のファイル", toNative("/a/b"), toNative("/a/b/c.txt"), true],
		["深い子", toNative("/a/b"), toNative("/a/b/c/d/e.txt"), true],
		["parent の末尾にセパレータがある", toNative("/a/b/"), toNative("/a/b/c.txt"), true],
		["child の末尾にセパレータがある", toNative("/a/b"), toNative("/a/b/c/"), true],
		["末尾セパレータ違いの同一パス", toNative("/a/b/"), toNative("/a/b"), true],
		["`.` を挟むが同じ場所", toNative("/a/b"), toNative("/a/b/./c.txt"), true],
		["`..` を含むが中に留まる child", toNative("/a/b"), toNative("/a/b/c/../d.txt"), true],
		["`..` を含む parent（解決すると同じ場所）", toNative("/a/x/../b"), toNative("/a/b/c.txt"), true],
		// path.resolve 後の parent が末尾セパレータで終わる唯一の形。
		["parent がルート", ROOT, ROOT + toNative("a/b"), true],
		["ルート同士", ROOT, ROOT, true],

		// --- 外に出ているもの ---
		["親ディレクトリ", toNative("/a/b"), toNative("/a"), false],
		["ルート", toNative("/a/b"), ROOT, false],
		// **セパレータ境界**: 素朴な startsWith だと `/a/bb` が `/a/b` の中に見えてしまう。
		["兄弟（接頭辞が一致するだけ）", toNative("/a/b"), toNative("/a/bb"), false],
		["兄弟の配下", toNative("/a/b"), toNative("/a/b-backup/c.txt"), false],
		["接尾辞が付いただけの兄弟ファイル", toNative("/a/b"), toNative("/a/b.bak"), false],
		["`..` で外へ抜ける child", toNative("/a/b"), toNative("/a/b/../../etc/passwd"), false],
		["`..` を積んでルートより上へ抜ける child", toNative("/a/b"), toNative("/a/b/../../../../etc/passwd"), false],
		["まったく無関係なパス", toNative("/a/b"), toNative("/var/log/syslog"), false],
		["child だけがルート直下", ROOT + toNative("a/b"), ROOT + toNative("c"), false],
	])("%s: parent=%j child=%j → %s", (_label, parent, child, expected) => {
		expect(isPathInside(parent, child)).toBe(expected)
	})

	it("相対パスは同じ基準（process.cwd()）で解決してから比べる", () => {
		expect(isPathInside(toNative("a/b"), toNative("a/b/c.txt"))).toBe(true)
		expect(isPathInside(toNative("a/b"), toNative("a/c.txt"))).toBe(false)
		// 片方だけ相対でも、解決後に同じ場所を指すなら中と判定する。
		expect(isPathInside(toNative("a/b"), path.resolve(toNative("a/b"), "c.txt"))).toBe(true)
	})

	it("親子は非対称（逆向きには成立しない）", () => {
		const parent = toNative("/a/b")
		const child = toNative("/a/b/c")

		expect(isPathInside(parent, child)).toBe(true)
		expect(isPathInside(child, parent)).toBe(false)
	})
})

// ---------------------------------------------------------------------------

// isPathOutsideWorkspace は「そのパスがどの workspace フォルダにも属さないか」を判定する。
// mention 展開やファイル書き込みの許可判定に効くため、境界（フォルダ自身・接頭辞が一致するだけの
// 兄弟）を固定する。workspace 状態は global mock（__mocks__/vscode.js）を差し替えて与える。
describe("isPathOutsideWorkspace", () => {
	const WS = path.resolve(path.sep, "ws")

	function setFolders(folders: Array<{ uri: { fsPath: string } }> | undefined) {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders
	}

	afterEach(() => {
		// global mock の既定（空配列）へ戻す。
		setFolders([])
	})

	it("workspace フォルダが空なら安全側に倒して常に outside 扱い", () => {
		setFolders([])
		expect(isPathOutsideWorkspace(path.join(WS, "a.ts"))).toBe(true)
	})

	it("workspaceFolders が undefined でも outside 扱い", () => {
		setFolders(undefined)
		expect(isPathOutsideWorkspace(path.join(WS, "a.ts"))).toBe(true)
	})

	it("workspace 配下のファイルは inside（false）", () => {
		setFolders([{ uri: { fsPath: WS } }])
		expect(isPathOutsideWorkspace(path.join(WS, "src", "a.ts"))).toBe(false)
	})

	it("workspace フォルダそのものは inside（false）", () => {
		setFolders([{ uri: { fsPath: WS } }])
		expect(isPathOutsideWorkspace(WS)).toBe(false)
	})

	it("`..` を解決して workspace の外へ出れば outside（true）", () => {
		setFolders([{ uri: { fsPath: WS } }])
		expect(isPathOutsideWorkspace(path.join(WS, "..", "other", "secret.txt"))).toBe(true)
	})

	it("接頭辞が一致するだけの兄弟フォルダは outside（セパレータ境界）", () => {
		// "/ws-backup" は "/ws" の startsWith だが、セパレータ境界で弾く。
		setFolders([{ uri: { fsPath: WS } }])
		expect(isPathOutsideWorkspace(`${WS}-backup${path.sep}a.ts`)).toBe(true)
	})

	it("複数フォルダのうちどれかに属していれば inside（false）", () => {
		const other = path.resolve(path.sep, "other")
		setFolders([{ uri: { fsPath: WS } }, { uri: { fsPath: other } }])
		expect(isPathOutsideWorkspace(path.join(other, "b.ts"))).toBe(false)
	})
})
