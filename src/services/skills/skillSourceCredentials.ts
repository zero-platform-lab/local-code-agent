import { spawn } from "child_process"

import { redactCredentials } from "./skillSourceFetcher"

/**
 * HTTPS の取得元の資格情報を、git の保管庫へ預ける（`FR-EXT-06` `FR-EXT-06a`）。
 *
 * **本製品は値を保持しない。** 持たなければ、書き出しから除く処理も、記録から伏せる
 * 処理も、保存先を守る処理も要らない。預けたあとの clone と pull は、こちらが何も
 * しなくても通る。
 *
 * **値は標準入力だけで渡す**（`FR-EXT-06b`）。URL へ埋めると `.git/config` に残り、
 * `-c` で渡すと `ps` から読め、環境変数で渡すと子プロセスの環境に残る。
 *
 * SSH の取得元では、この仕組みを使わない。鍵は git と ssh が扱う。
 */

export type CredentialTarget = {
	/** `https`。 */
	protocol: string
	/** `gitlab.example.com`。既定でないポートは `gitlab.example.com:8443` のように付く。 */
	host: string
}

const HTTP_URL = /^(https?):\/\/([^/?#]+)/i

/**
 * URL から `git credential` の宛先を取り出す。
 *
 * HTTPS 以外は `undefined` を返す。SSH の取得元は鍵で通すので、預ける値が無い。
 */
export function credentialTargetForUrl(rawUrl: string): CredentialTarget | undefined {
	const match = HTTP_URL.exec(rawUrl.trim())
	if (!match) {
		return undefined
	}

	// `user@host` と書かれていても、宛先はホストだけ。
	const authority = match[2].replace(/^[^@]*@/, "")
	if (!authority) {
		return undefined
	}

	return { protocol: match[1].toLowerCase(), host: authority.toLowerCase() }
}

/**
 * 改行と NUL を含む値を拒む。
 *
 * `git credential` の入力は 1 行 1 項目で、空行が終わりを表す。値に改行が入ると、
 * そこから先が別の項目として読まれる。利用者名の欄に `x\nhost=evil` と書けば、
 * 別のホストの資格情報として預けられてしまう。
 */
export function isSafeCredentialValue(value: string): boolean {
	return !/[\n\r\0]/.test(value)
}

/** `git credential approve` へ渡す標準入力。空行で閉じる。 */
export function buildCredentialApproveInput(target: CredentialTarget, username: string, password: string): string {
	const lines = [`protocol=${target.protocol}`, `host=${target.host}`, `username=${username}`, `password=${password}`]
	return `${lines.join("\n")}\n\n`
}

/**
 * `git config --get-all credential.helper` の出力に、保管庫が 1 つでもあるかを見る
 * （`FR-EXT-06c`）。
 *
 * Linux では既定で何も設定されておらず、その場合 `approve` は黙って何もしない。
 * 預けられないまま次の取得が失敗するので、預ける前に見る。
 */
export function hasCredentialHelper(configOutput: string): boolean {
	return configOutput.split("\n").some((line) => line.trim().length > 0)
}

export type StoreCredentialsParams = {
	url: string
	username: string
	password: string
}

export type StoreCredentialsResult =
	| { ok: true; host: string }
	| { ok: false; reason: "not-https" | "unsafe-value" | "no-helper" | "failed"; error?: string }

export type CredentialDeps = {
	/** `git config --get-all credential.helper` の出力。未設定なら空。 */
	readCredentialHelpers: () => Promise<string>
	/** `git credential approve` に標準入力を渡して実行する。 */
	approve: (input: string) => Promise<void>
}

type GitRun = { code: number | null; stdout: string; stderr: string }

function runGit(args: string[], input: string): Promise<GitRun> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		})

		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.on("error", reject)
		child.on("close", (code) => resolve({ code, stdout, stderr }))

		// 子が標準入力を読まずに終えると EPIPE が上がる。`git config` がそうで、
		// 握り潰さないと拡張ホストごと異常終了する。結果は close の終了コードで判る。
		child.stdin.on("error", () => {})
		child.stdin.end(input)
	})
}

/** 既定の依存。git を起動するのはここだけで、ほかは注入で差し替えられる。 */
export const defaultCredentialDeps: CredentialDeps = {
	readCredentialHelpers: async () => {
		// 未設定のとき `git config --get-all` は 1 で終わる。無いだけなので空として扱う。
		const { stdout } = await runGit(["config", "--get-all", "credential.helper"], "")
		return stdout
	},
	approve: async (input) => {
		const { code, stderr } = await runGit(["credential", "approve"], input)
		if (code !== 0) {
			throw new Error(`git credential approve が ${code} で終わりました: ${stderr.trim()}`)
		}
	},
}

export async function storeSkillSourceCredentials(
	params: StoreCredentialsParams,
	deps: CredentialDeps = defaultCredentialDeps,
): Promise<StoreCredentialsResult> {
	const target = credentialTargetForUrl(params.url)
	if (!target) {
		return { ok: false, reason: "not-https" }
	}

	if (!isSafeCredentialValue(params.username) || !isSafeCredentialValue(params.password)) {
		return { ok: false, reason: "unsafe-value" }
	}

	if (!hasCredentialHelper(await deps.readCredentialHelpers())) {
		return { ok: false, reason: "no-helper" }
	}

	try {
		await deps.approve(buildCredentialApproveInput(target, params.username, params.password))
		return { ok: true, host: target.host }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { ok: false, reason: "failed", error: redactCredentials(message) }
	}
}
