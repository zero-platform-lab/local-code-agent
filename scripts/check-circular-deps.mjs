#!/usr/bin/env node
/**
 * 循環依存ガード（新規サイクル禁止 / 辺ベース・決定的）
 *
 * madge で `src` の依存グラフを取得し、強連結成分(SCC)を計算する。
 * 「同一 SCC 内の辺 = いずれかの循環に関与する辺」を循環辺(cyclic edge)とみなし、
 * その集合をコミット済みベースライン (scripts/circular-deps-baseline.json) と照合する。
 *
 *  - ベースラインに無い「新規の循環辺」が1本でもあれば exit 1（CIを落とす）
 *  - ベースラインから「減った」循環辺は歓迎し、baseline 更新を促すだけ（成功扱い）
 *
 * なぜ「サイクル経路」ではなく「循環辺」か:
 *   madge の --circular が返すサイクル経路の集合は探索順に依存し、辺を1本足し引き
 *   しただけで既存サイクルの報告の仕方が変わる（＝改善しただけで誤検知が出る）。
 *   SCC 由来の循環辺集合はグラフから決定的に定まり、この揺れが無い。
 *
 * 使い方:
 *   node scripts/check-circular-deps.mjs            # 照合（CI/ローカル）
 *   node scripts/check-circular-deps.mjs --update   # ベースライン再生成（減った時など）
 */
import madge from "madge"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, "..")
const BASELINE_PATH = join(scriptDir, "circular-deps-baseline.json")

// madge に渡す解析対象・設定（README/CI と同じ条件）
const TARGET = "src"
const MADGE_OPTIONS = {
	fileExtensions: ["ts"],
	tsConfig: join(repoRoot, "tsconfig.json"),
}

/**
 * 強連結成分(SCC)を Tarjan 法で計算する（再帰スタック溢れを避けるため反復実装）。
 * @param {Record<string, string[]>} graph 隣接リスト（node -> deps[]）
 * @returns {Map<string, number>} 各ノードの SCC ID
 */
function computeSccIds(graph) {
	const nodes = Object.keys(graph)
	const index = new Map()
	const lowlink = new Map()
	const onStack = new Set()
	const stack = []
	const sccId = new Map()
	let nextIndex = 0
	let nextScc = 0

	for (const start of nodes) {
		if (index.has(start)) continue
		// 反復 DFS: フレームは {node, iter(隣接インデックス)}
		const work = [{ node: start, i: 0 }]
		index.set(start, nextIndex)
		lowlink.set(start, nextIndex)
		nextIndex++
		stack.push(start)
		onStack.add(start)

		while (work.length > 0) {
			const frame = work[work.length - 1]
			const { node } = frame
			const deps = graph[node] || []
			if (frame.i < deps.length) {
				const w = deps[frame.i]
				frame.i++
				if (!(w in graph)) continue // グラフ外（型のみ等で解決されない）ノードは無視
				if (!index.has(w)) {
					index.set(w, nextIndex)
					lowlink.set(w, nextIndex)
					nextIndex++
					stack.push(w)
					onStack.add(w)
					work.push({ node: w, i: 0 })
				} else if (onStack.has(w)) {
					lowlink.set(node, Math.min(lowlink.get(node), index.get(w)))
				}
			} else {
				// node の探索完了。SCC の根なら pop してまとめる
				if (lowlink.get(node) === index.get(node)) {
					while (true) {
						const w = stack.pop()
						onStack.delete(w)
						sccId.set(w, nextScc)
						if (w === node) break
					}
					nextScc++
				}
				work.pop()
				if (work.length > 0) {
					const parent = work[work.length - 1].node
					lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)))
				}
			}
		}
	}
	return sccId
}

/**
 * 循環辺（同一 SCC 内で結ばれる u->v, u≠v）を "u -> v" 文字列の集合として返す。
 */
async function collectCyclicEdges() {
	const res = await madge(TARGET, { ...MADGE_OPTIONS, baseDir: repoRoot })
	const graph = res.obj()
	const sccId = computeSccIds(graph)
	const edges = []
	for (const [node, deps] of Object.entries(graph)) {
		for (const dep of deps) {
			if (dep === node) continue
			if (sccId.has(node) && sccId.has(dep) && sccId.get(node) === sccId.get(dep)) {
				edges.push(`${node} -> ${dep}`)
			}
		}
	}
	return [...new Set(edges)].sort()
}

function loadBaseline() {
	try {
		const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
		return Array.isArray(raw.cyclicEdges) ? raw.cyclicEdges : []
	} catch {
		return []
	}
}

function writeBaseline(edges) {
	const payload = {
		comment:
			"循環依存のベースライン。cyclicEdges = 同一 SCC 内の辺（＝いずれかの循環に関与する辺）。" +
			"新規の循環辺はCIで拒否される。減らしたら `node scripts/check-circular-deps.mjs --update` で締め直す。",
		count: edges.length,
		cyclicEdges: edges,
	}
	writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, "\t") + "\n")
}

async function main() {
	process.chdir(repoRoot) // madge の cwd 依存を避ける
	const update = process.argv.includes("--update")
	const current = await collectCyclicEdges()

	if (update) {
		writeBaseline(current)
		console.log(`✅ ベースラインを更新しました: ${current.length} 循環辺 -> ${BASELINE_PATH}`)
		return
	}

	const baseline = new Set(loadBaseline())
	const currentSet = new Set(current)
	const added = current.filter((e) => !baseline.has(e))
	const removed = [...baseline].filter((e) => !currentSet.has(e))

	if (removed.length > 0) {
		console.log(`🎉 ${removed.length} 本の循環辺が解消されています:`)
		for (const e of removed) console.log(`   - ${e}`)
		console.log("   → `node scripts/check-circular-deps.mjs --update` でベースラインを締め直してください。\n")
	}

	if (added.length > 0) {
		console.error(
			`❌ 新規の循環依存（辺）が ${added.length} 本検出されました（ベースライン: ${baseline.size} 本）:`,
		)
		for (const e of added) console.error(`   + ${e}`)
		console.error(
			"\nこの変更で新しい循環依存が生まれています。依存の向きを一方向化するか、\n" +
				"意図的に許容する場合のみ --update でベースラインに取り込んでください。",
		)
		process.exit(1)
	}

	console.log(`✅ 新規の循環依存はありません（現状 ${current.length} 循環辺 / ベースライン ${baseline.size} 本）。`)
}

main().catch((err) => {
	console.error("循環依存チェックの実行に失敗しました:", err)
	process.exit(2)
})
