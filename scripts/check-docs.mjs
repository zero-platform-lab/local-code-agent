#!/usr/bin/env node
/**
 * 要件と機能仕様が、実装とずれていないかを機械で確かめる。
 *
 * **なぜ要るか。**
 *
 * 人が数え直す前提の数値は必ず古くなる。このリポジトリでも、書いた時点では
 * 正しかった数値が実装の変更に追いつかず、判断を誤らせた例がある。
 *
 * - `docs/feature-inventory.md` の「ツール（`toolNames` 全24）」は、実際には 23 だった
 * - 同じ文書の設定タブの一覧は、11 へ整理する前（PR #43）の顔ぶれのままだった
 *
 * 要件の識別子も同じである。`docs/features/` が `FR-XXX-99` と書いても、
 * `docs/requirements.md` にその要件が無ければ、対応表として役に立たない。
 * **数えるのと突き合わせるのは機械の仕事。**
 *
 * 確かめるもの。
 *
 * 1. 機能仕様が書いた要件の識別子が、`docs/requirements.md` の 3 章に実在すること
 * 2. 3 章の要件が、4.2 の検証の表に漏れなく載っていること
 * 3. 3 章の要件が、いずれかの機能仕様に載っていること（対応先の無い要件を作らない）
 * 4. `docs/requirements.md` の 5.1 の対応表と、`docs/features/` の実ファイルが一致すること
 * 5. 機能仕様が 6 節（目的・方式・制約・危険なところ・確かめ方・できていないこと）を持つこと
 * 6. `docs/features/README.md` の「件数」の表が、一次ソースから数えた値と合うこと
 * 7. ほかの文書に書いた件数が、同じ値と合うこと（`inlineCounts`）
 * 8. 文書が引いたファイルが実在すること。**テストはディレクトリまで書くこと**
 * 9. 解決し損ねた衝突の印が入っていないこと
 *
 * **7 は「各数値の記載箇所は 1 つに限る」（`AGENTS.md`）に反しない。** あの規則は、
 * 手で写した数値が黙って古くなることを避けるためにある。ここで突き合わせる数値は
 * 黙って古くならない。書き方を変えて正規表現が当たらなくなった場合も失敗させる。
 *
 * ずれを報告して終了コード 1 で終わる。
 *
 * 使い方:
 *   node scripts/check-docs.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const REQUIREMENTS = "docs/requirements.md"
const FEATURES_DIR = "docs/features"
const FEATURES_README = "docs/features/README.md"

/** 機能仕様が必ず持つ節。README.md は索引なので対象から外す。 */
const REQUIRED_SECTIONS = ["目的", "方式", "制約", "危険なところ", "確かめ方", "できていないこと"]

/** 要件の識別子。派生は末尾の英小文字で表す（`FR-LOOP-08a`）。 */
const ID_PATTERN = /(?:FR|NFR)-[A-Z0-9]+-[0-9]+[a-z]?/

const problems = []
const report = (where, message) => problems.push(`${where}: ${message}`)

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8")

/** `開始` の後の最初の `= [` から、対応する `]` までを返す。 */
function arrayLiteralAfter(source, anchor) {
	const at = source.indexOf(anchor)
	if (at < 0) return null
	const open = source.indexOf("= [", at)
	if (open < 0) return null
	const close = source.indexOf("]", open + 3)
	if (close < 0) return null
	return source.slice(open + 3, close)
}

/** 文字列リテラルの数を数える。 */
const countStrings = (chunk) => (chunk === null ? null : (chunk.match(/"[^"]*"/g) ?? []).length)

/**
 * `アンカー` に続く `z.object({...})` / `.extend({...})` の直下のキー名を返す。
 * 対応する `)` まで括弧を数えて切り出すので、途中に `z.record(...)` があってもよい。
 */
function objectKeysAfter(source, anchor) {
	const at = source.indexOf(anchor)
	if (at < 0) return null
	const open = source.indexOf("({", at)
	if (open < 0) return null
	let depth = 1
	let i = open + 2
	while (depth > 0 && i < source.length) {
		if (source[i] === "(") depth++
		else if (source[i] === ")") depth--
		i++
	}
	if (depth !== 0) return null
	return (source.slice(open + 2, i - 1).match(/^\t(\w+):/gm) ?? []).map((m) => m.trim().slice(0, -1))
}

// --- 一次ソースから数える ------------------------------------------------

/** `docs/requirements.md` の 3 章が宣言する要件の識別子（宣言の順）。 */
function declaredRequirements(doc) {
	const from = doc.indexOf("\n## 3. 要件")
	const to = doc.indexOf("\n## 4. 検証")
	if (from < 0 || to < 0) {
		report(REQUIREMENTS, "3 章または 4 章の見出しが見つからない")
		return []
	}
	const rows = doc.slice(from, to).matchAll(new RegExp(`^\\| \`(${ID_PATTERN.source})\``, "gm"))
	return [...rows].map((m) => m[1])
}

/** 4.2 の検証の表に載っている識別子。 */
function verifiedRequirements(doc) {
	const from = doc.indexOf("\n### 4.2 要件ごとの検証")
	if (from < 0) {
		report(REQUIREMENTS, "4.2 の見出しが見つからない")
		return []
	}
	const to = doc.indexOf("\n## 5. 補足情報", from)
	const rows = doc.slice(from, to < 0 ? undefined : to).matchAll(new RegExp(`^\\| \`(${ID_PATTERN.source})\``, "gm"))
	return [...rows].map((m) => m[1])
}

const counters = {
	要件: (deps) => deps.declared.length,
	機能要件: (deps) => deps.declared.filter((id) => id.startsWith("FR-")).length,
	非機能要件: (deps) => deps.declared.filter((id) => id.startsWith("NFR-")).length,
	機能仕様: (deps) => deps.featureFiles.length,
	ツール: () => {
		const source = read("packages/types/src/tool.ts")
		return countStrings(arrayLiteralAfter(source, "toolNames"))
	},
	ツールグループ: () => {
		const source = read("src/shared/tools.ts")
		const at = source.indexOf("TOOL_GROUPS: Record")
		const block = source.slice(at, source.indexOf("\n}\n", at))
		return (block.match(/^\t(\w+): \{/gm) ?? []).length
	},
	常時利用のツール: () => countStrings(arrayLiteralAfter(read("src/shared/tools.ts"), "ALWAYS_AVAILABLE_TOOLS")),
	役割モード: () => {
		const source = read("packages/types/src/mode.ts")
		return (source.slice(source.indexOf("DEFAULT_MODES")).match(/^\t\tslug:/gm) ?? []).length
	},
	自律モード: () => countStrings(arrayLiteralAfter(read("packages/types/src/autonomy.ts"), "autonomyModes")),
	既定で拒否するコマンド: () =>
		countStrings(arrayLiteralAfter(read("packages/types/src/autonomy.ts"), "DEFAULT_DENIED_COMMANDS")),
	グローバル設定のキー: () => {
		const source = read("packages/types/src/global-settings.ts")
		const at = source.indexOf("globalSettingsSchema = z.object")
		const block = source.slice(at, source.indexOf("\n})", at))
		return (block.match(/^\t[a-zA-Z][\w]*:/gm) ?? []).length
	},
	"VS Code の設定のキー": () => Object.keys(manifest().configuration.properties).length,
	コマンド: () => manifest().commands.length,
	キーバインド: () => manifest().keybindings.length,
	設定のタブ: () => {
		const source = read("webview-ui/src/components/settings/SettingsView.tsx")
		const at = source.indexOf('{ id: "providers"')
		if (at < 0) return null
		const close = source.indexOf("]", at)
		return (source.slice(at, close).match(/\{ id: "\w+"/g) ?? []).length
	},
	実験的な機能: () => countStrings(arrayLiteralAfter(read("packages/types/src/experiment.ts"), "experimentIds")),
	品質ゲートの段: () => {
		// `--strict` のときだけ走る install は数えない。`NFR-MNT-01a` が並べるのは
		// 毎回走る段である。段を足したら件数が合わなくなり、条文へ戻される。
		const steps = read("scripts/ci-local.sh").match(/^\s*run_step "[^"]+"/gm) ?? []
		return steps.filter((line) => !line.includes("--frozen-lockfile")).length
	},
	プロバイダ設定のキー: () => {
		// `providerSettingsSchema` は複数のスキーマの shape を広げて作る。
		// 広げる先を 1 つずつ数えて、重複を除いた数を返す。
		const provider = read("packages/types/src/provider-settings.ts")
		const index = read("packages/types/src/codebase-index.ts")
		const parts = [
			["apiProvider"],
			objectKeysAfter(provider, "const baseProviderSettingsSchema"),
			objectKeysAfter(provider, "const apiModelIdProviderModelSchema"),
			objectKeysAfter(provider, "const openAiSchema"),
			objectKeysAfter(provider, "const fakeAiSchema"),
			objectKeysAfter(index, "export const codebaseIndexProviderSchema"),
		]
		if (parts.some((part) => part === null)) return null
		return new Set(parts.flat()).size
	},
}

/**
 * ほかの文書に書いた件数。**正規表現が当たらなければ失敗させる。**
 * 当たらないまま素通りさせると、書き方を変えた時点で検査が消える。
 */
const inlineCounts = [
	["docs/feature-inventory.md", /### A1\. ツール（`toolNames` 全(\d+)/, "ツール"],
	["docs/feature-inventory.md", /### A2\. 役割モード（`DEFAULT_MODES` 全(\d+)/, "役割モード"],
	["docs/feature-inventory.md", /### A6\. experiments（[^）]*、実フラグ(\d+)つ）/, "実験的な機能"],
	["docs/feature-inventory.md", /### B1\. プロバイダ設定（[^）]*、(\d+)キー）/, "プロバイダ設定のキー"],
	["docs/feature-inventory.md", /### B2\. グローバル設定（[^）]*、(\d+)キー）/, "グローバル設定のキー"],
	["docs/feature-inventory.md", /### B3\. VS Code 設定（[^）]*、(\d+)キー）/, "VS Code の設定のキー"],
	["docs/feature-inventory.md", /### C1\. コマンド（contributes\.commands、(\d+)）/, "コマンド"],
	["docs/feature-inventory.md", /### C2\. 設定タブ（[^）]*、(\d+)）/, "設定のタブ"],
	["AGENTS.md", /組み込みの役割モードは `code` と `research` の (\d+) 件である/, "役割モード"],
	["docs/architecture.md", /組み込みは `code` と `research` の (\d+) 件である/, "役割モード"],
	["docs/architecture.md", /`manual` \/ `autoEdit` \/ `auto` \/ `plan` の (\d+) 種類/, "自律モード"],
]

let manifestCache
function manifest() {
	manifestCache ??= JSON.parse(read("src/package.json")).contributes
	return manifestCache
}

// --- 検査 ----------------------------------------------------------------

const doc = read(REQUIREMENTS)
const declared = declaredRequirements(doc)
const declaredSet = new Set(declared)

// 宣言そのものが重複していないか。重複すると、後から書いたほうが黙って上書きされる。
const seen = new Set()
for (const id of declared) {
	if (seen.has(id)) report(REQUIREMENTS, `要件 ${id} を 2 回宣言している`)
	seen.add(id)
}

const featureFiles = existsSync(join(repoRoot, FEATURES_DIR))
	? readdirSync(join(repoRoot, FEATURES_DIR))
			.filter((name) => name.endsWith(".md") && name !== "README.md")
			.sort()
	: []

if (featureFiles.length === 0) report(FEATURES_DIR, "機能仕様が 1 本も無い")

// 1. 機能仕様が書いた識別子が実在するか / 3. 対応先の無い要件が無いか
const covered = new Set()
for (const name of [...featureFiles, "README.md"]) {
	const rel = `${FEATURES_DIR}/${name}`
	const body = read(rel)
	for (const [, id] of body.matchAll(new RegExp("`(" + ID_PATTERN.source + ")`", "g"))) {
		if (!declaredSet.has(id)) report(rel, `要件 ${id} は ${REQUIREMENTS} に無い`)
		covered.add(id)
	}
	// 5. 6 節を持つか（README.md は索引なので対象外）
	if (name !== "README.md") {
		for (const section of REQUIRED_SECTIONS) {
			if (!new RegExp(`^##+ ${section}$`, "m").test(body)) report(rel, `「${section}」の節が無い`)
		}
	}
	// 7. 衝突の印
	if (/^(<{7}|={7}|>{7})( |$)/m.test(body)) report(rel, "解決し損ねた衝突の印が残っている")
}

for (const id of declared) {
	if (!covered.has(id)) report(FEATURES_DIR, `要件 ${id} に対応する機能仕様が無い`)
}

// 2. 4.2 の検証の表の網羅
const verified = new Set(verifiedRequirements(doc))
for (const id of declared) {
	if (!verified.has(id)) report(REQUIREMENTS, `要件 ${id} が 4.2 の検証の表に無い`)
}
for (const id of verified) {
	if (!declaredSet.has(id)) report(REQUIREMENTS, `4.2 の ${id} は 3 章で宣言されていない`)
}

// 4. 5.1 の対応表と実ファイル
const listed = new Set([...doc.matchAll(/\]\(features\/([\w.-]+\.md)\)/g)].map((m) => m[1]))
for (const name of featureFiles) {
	if (!listed.has(name)) report(REQUIREMENTS, `5.1 の対応表に ${name} が無い`)
}
for (const name of listed) {
	if (!existsSync(join(repoRoot, FEATURES_DIR, name))) report(REQUIREMENTS, `5.1 が指す ${name} が存在しない`)
}

// 6. 件数の表
const readmeBody = read(FEATURES_README)
// prettier が列の幅を揃えるので、桁を決め打ちにせず `|` で割ってから前後を落とす。
const declaredCounts = new Map()
for (const line of readmeBody.split("\n")) {
	if (!line.startsWith("|")) continue
	const cells = line
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim())
	if (cells.length !== 3 || !/^\d+$/.test(cells[1])) continue
	declaredCounts.set(cells[0].replace(/`/g, ""), Number(cells[1]))
}
// 数え直しは 1 回だけにする。同じ件数を複数の文書が書いていることがある。
const counted = new Map()
function countOf(label) {
	if (!counted.has(label)) counted.set(label, counters[label]({ declared, featureFiles }))
	return counted.get(label)
}

for (const label of Object.keys(counters)) {
	if (!declaredCounts.has(label)) {
		report(FEATURES_README, `「件数」の表に「${label}」の行が無い`)
		continue
	}
	const actual = countOf(label)
	if (actual === null) {
		report(FEATURES_README, `「${label}」を一次ソースから数えられなかった`)
	} else if (actual !== declaredCounts.get(label)) {
		report(FEATURES_README, `「${label}」は ${declaredCounts.get(label)} と書いてあるが、実際は ${actual}`)
	}
}
for (const label of declaredCounts.keys()) {
	if (!(label in counters)) report(FEATURES_README, `「${label}」を数える方法が check-docs.mjs に無い`)
}

// 7. ほかの文書に書いた件数
for (const [rel, pattern, label] of inlineCounts) {
	const found = read(rel).match(pattern)
	if (!found) {
		report(rel, `「${label}」の件数を書いた箇所が見つからない。書き方を変えたなら check-docs.mjs も直す`)
		continue
	}
	const actual = countOf(label)
	if (actual === null) {
		report(rel, `「${label}」を一次ソースから数えられなかった`)
	} else if (Number(found[1]) !== actual) {
		report(rel, `「${label}」は ${found[1]} と書いてあるが、実際は ${actual}`)
	}
}

// 8. 文書が引いたファイルが実在するか
//
// **なぜ要るか。** 4.2 が引いていた `utils/__tests__/export.spec.ts` は、保存先パスの
// 解決を確かめるだけで、要件が言う「書き出しに秘密が入らないこと」を見ていなかった。
// 実在しないファイルや、ディレクトリを省いた書き方も混じっていた。**実在するかどうかは
// 機械で見られる。** 中身が要件に合っているかまでは見られないので、そこは人が読む。
const FILE_REF = /`([A-Za-z0-9_@./-]+\.(?:ts|tsx|mjs|js|py|json|sh))`/g
const TEST_FILE = /\.(?:spec|test)\.tsx?$/

/** 4.2 と機能仕様だけを見る。3 章までは要件の条文で、ファイルを引かない。 */
const referencingDocs = [
	[REQUIREMENTS, doc.slice(doc.indexOf("### 4.2"))],
	...[...featureFiles, "README.md"].map((name) => {
		const rel = `${FEATURES_DIR}/${name}`
		return [rel, read(rel)]
	}),
]

for (const [rel, body] of referencingDocs) {
	for (const [, ref] of body.matchAll(FILE_REF)) {
		if (!ref.includes("/")) {
			// テスト以外の裸の名前は、本文で機能を指しているだけのことがある。
			if (TEST_FILE.test(ref)) report(rel, `${ref} はディレクトリまで書く`)
			continue
		}
		if (!existsSync(join(repoRoot, ref)) && !existsSync(join(repoRoot, "src", ref))) {
			report(rel, `${ref} は存在しない`)
		}
	}
}

// 9. 要件定義書そのものの衝突の印
if (/^(<{7}|={7}|>{7})( |$)/m.test(doc)) report(REQUIREMENTS, "解決し損ねた衝突の印が残っている")

// --- 結果 ----------------------------------------------------------------

if (problems.length > 0) {
	console.error(`文書と実装がずれている（${problems.length} 件）\n`)
	for (const line of problems) console.error(`  ${line}`)
	console.error("")
	process.exit(1)
}

console.log(`要件 ${declared.length} 件 / 機能仕様 ${featureFiles.length} 本 — ずれは無い`)
