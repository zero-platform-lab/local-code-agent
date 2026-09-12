import * as path from "path"

/**
 * スキルの取得元の URL を、置き場所と経路へ分解する。
 *
 * **置き場所は URL から機械的に決める**（`FR-EXT-05c1`）。利用者が名前を付けないので、
 * 同じリポジトリを 2 回登録しても同じ場所になり、重複を弾く処理が要らない。
 *
 * 経路（`https` か `ssh` か）を返すのは、**proxy が効くかどうかが経路で決まる**ため
 * である（`FR-EXT-05b3`）。git の `http.proxy` は SSH の取得元では黙って無視される。
 *
 * **`new URL()` を使わずに自分で分解する。** あちらは `a/../../etc` を `etc` へ
 * 正規化してから返すため、上へ抜ける書き方が黙って別のパスへ化ける。利用者が
 * 書いたとおりに見て、怪しければ拒む（`FR-EXT-05c2`）。
 */

export type SkillSourceTransport = "https" | "ssh"

export type ParsedSkillSource = {
	/** `gitlab.example.com`。既定でないポートは `gitlab.example.com_2222` のように付く。 */
	host: string
	/** `["platform", "skills"]`。末尾の `.git` は落とす。 */
	segments: string[]
	/** `gitlab.example.com/platform/skills`。OS の区切りで組み立てる。 */
	directory: string
	transport: SkillSourceTransport
}

export type ParseResult = { valid: true; value: ParsedSkillSource } | { valid: false; error: string }

/**
 * ディレクトリ名に使えない文字。Windows が拒む一式に合わせる。
 *
 * **`/` は入れない。** 区切りとして先に割ってあるので、ここへ来る時点で 1 つの区切りの
 * 中身しか見ていない。制御文字は別に数値で見る（ソースへ直接書かないため）。
 */
const UNSAFE_CHARS = /[<>:"|?*\\]/

const SCHEME = /^(https?|ssh):\/\//i

/** `[user@]host:path` の形。`ssh://` を付けない SCP 風の書き方。 */
const SCP_LIKE = /^(?:[^@/]+@)?([^@/:]+):(.+)$/

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

function isUnsafe(value: string): boolean {
	return UNSAFE_CHARS.test(value) || hasControlChar(value)
}

function normalizeSegments(rawPath: string): { valid: true; segments: string[] } | { valid: false; error: string } {
	const segments = rawPath
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)

	if (segments.length === 0) {
		return { valid: false, error: "URL にリポジトリのパスがありません" }
	}

	for (const segment of segments) {
		// **`..` を拒む**（`FR-EXT-05c2`）。置き場所の上へ抜けられると、取得の処理が
		// `skill-sources` の外を書き換えられる。
		if (segment === "." || segment === "..") {
			return { valid: false, error: "URL のパスに `.` または `..` を含められません" }
		}
		if (isUnsafe(segment)) {
			return { valid: false, error: `URL のパスに使えない文字が含まれています: ${segment}` }
		}
	}

	// 末尾の `.git` は同じリポジトリの別表記なので落とす。落とさないと
	// `foo.git` と `foo` が別の置き場所になる。
	const last = segments[segments.length - 1]!
	const trimmed = last.endsWith(".git") ? last.slice(0, -".git".length) : last

	if (trimmed.length === 0) {
		return { valid: false, error: "リポジトリ名が空です" }
	}

	segments[segments.length - 1] = trimmed
	return { valid: true, segments }
}

function hostWithPort(hostname: string, port: string | undefined): string {
	// ポートをそのまま付けると `:` が入り、Windows でディレクトリ名に使えない。
	// 付けないと同じホストの別ポートが同じ置き場所になるので、`_` で繋ぐ。
	return port ? `${hostname}_${port}` : hostname
}

/** `[user@]host[:port]` を分ける。 */
function splitAuthority(authority: string): { hostname: string; port?: string } | undefined {
	const withoutUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority
	if (!withoutUser) return undefined

	const colon = withoutUser.lastIndexOf(":")
	if (colon < 0) return { hostname: withoutUser }

	const port = withoutUser.slice(colon + 1)
	if (!/^\d+$/.test(port)) return undefined

	return { hostname: withoutUser.slice(0, colon), port }
}

function decodePath(rawPath: string): string | undefined {
	try {
		return decodeURIComponent(rawPath)
	} catch {
		return undefined
	}
}

export function parseSkillSourceUrl(rawUrl: string): ParseResult {
	const url = rawUrl.trim()

	if (!url) {
		return { valid: false, error: "URL が空です" }
	}

	let transport: SkillSourceTransport
	let hostname: string
	let port: string | undefined
	let rawPath: string

	const scheme = SCHEME.exec(url)
	if (scheme) {
		transport = scheme[1]!.toLowerCase() === "ssh" ? "ssh" : "https"
		const rest = url.slice(scheme[0].length)
		const slash = rest.indexOf("/")
		if (slash < 0) {
			return { valid: false, error: "URL にリポジトリのパスがありません" }
		}
		const authority = splitAuthority(rest.slice(0, slash))
		if (!authority) {
			return { valid: false, error: "ホスト名が正しくありません" }
		}
		hostname = authority.hostname
		port = authority.port
		const decoded = decodePath(rest.slice(slash))
		if (decoded === undefined) {
			return { valid: false, error: "URL のパスを解釈できません" }
		}
		rawPath = decoded
	} else {
		const matched = SCP_LIKE.exec(url)
		if (!matched) {
			return { valid: false, error: "URL の形式が正しくありません" }
		}
		transport = "ssh"
		hostname = matched[1]!
		rawPath = matched[2]!
	}

	if (!hostname || isUnsafe(hostname)) {
		return { valid: false, error: "ホスト名が正しくありません" }
	}

	const normalized = normalizeSegments(rawPath)
	if (!normalized.valid) {
		return normalized
	}

	const host = hostWithPort(hostname.toLowerCase(), port)

	return {
		valid: true,
		value: {
			host,
			segments: normalized.segments,
			directory: path.join(host, ...normalized.segments),
			transport,
		},
	}
}
