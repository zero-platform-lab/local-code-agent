// platform を指定して VSIX を作る。
//
// **なぜ包みが要るのか。** `vsce package` は `vscode:prepublish`（`pnpm bundle --production`）
// を実行し直す。そのため `pnpm bundle --target=...` と書いても、束ね直しで指定が失われ、
// **いま動いている機械の platform のものが入る**。Windows 向けに作ったつもりで Linux の
// native が入る、という取り違えが実際に起きた。
//
// 環境変数なら prepublish にも届く。シェルの書き方が platform で変わらないよう、
// `node` から渡す。
//
// 作ったあと、**中身が指定した platform のものかを確かめる**。ここを見ないと、同じ
// 取り違えが黙って通る。

import { spawnSync } from "child_process"
import { existsSync, readdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const here = path.dirname(fileURLToPath(import.meta.url))

const publish = process.argv.includes("--publish")
const targets = process.argv.filter((one) => one === "universal" || /^[a-z0-9]+-[a-z0-9]+$/.test(one))

// **platform を指さない作り方を許さない。**
//
// 指さないと、いま動いている機械の native だけが入る。ほかの platform で入れた人は、
// 第 2 層が黙って動かない（例外は `TaskPiiMasker` が握るので、画面には何も出ない）。
if (targets.length === 0) {
	console.error("使い方: node package-vsix.mjs <platform>-<arch> [<platform>-<arch> …] [--publish]")
	console.error("第 2 層の native を含むため、platform を指さずには作れない。")
	process.exit(1)
}

for (const target of targets) {
	buildOne(target)
}

/** 1 つ実行する。失敗したらそこで止める。 */
function run(command, args, env) {
	const result = spawnSync(command, args, { cwd: here, env, stdio: "inherit", shell: true })
	if (result.status !== 0) process.exit(result.status ?? 1)
}

function buildOne(target) {
	// 束ね直しにも届くよう、環境変数でも渡す（`vsce` が `vscode:prepublish` を実行し直す）。
	const env = { ...process.env, VSIX_TARGET: target }

	run("pnpm", ["bundle", "--production", `--target=${target}`], env)
	run("mkdirp", ["../bin"], env)

	// `universal` は platform を指さずに作る。受け取り手を絞らない配布物になる。
	const forTarget = target === "universal" ? [] : ["--target", target]

	if (publish) {
		// **2 つの店へ出す。** 片方だけにすると、もう片方の利用者が古い版のままになる。
		run("vsce", ["publish", "--no-dependencies", ...forTarget], env)
		run("ovsx", ["publish", "--no-dependencies", ...forTarget], env)
	} else {
		run("vsce", ["package", "--no-dependencies", ...forTarget, "--out", "../bin"], env)
	}

	// `universal` には native が入らない。確かめる対象が無い。
	if (target === "universal") {
		console.log("\n確認: universal には native を入れていない（第 2 層は動かない）。")
		return
	}

	// **確かめる。** 束ね直しで platform が戻っていないか、写した実物から見る。
	//
	// **`unzip` に頼らない。** Windows には無いことが多く、無いと検査が黙って素通りする。
	// この取り違えが起きたのはまさに Windows 向けを作ったときなので、そこで効かない検査には
	// 意味が無い。VSIX の中身は `dist/` の写しなので、そちらを直接見る。
	const binDir = path.join(here, "dist", "node_modules", "onnxruntime-node", "bin", "napi-v6")
	if (!existsSync(binDir)) {
		console.error(`\n${binDir} が無い。第 2 層の実行の仕組みが同梱されていない。`)
		process.exit(1)
	}

	const platforms = readdirSync(binDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) =>
			readdirSync(path.join(binDir, entry.name), { withFileTypes: true })
				.filter((arch) => arch.isDirectory())
				.map((arch) => `${entry.name}-${arch.name}`),
		)

	if (platforms.length !== 1 || platforms[0] !== target) {
		console.error(`\n${target} を作ったつもりが、入っているのは ${platforms.join(", ") || "（無し）"} である。`)
		process.exit(1)
	}

	console.log(`\n確認: ${target} の実行の仕組みだけが入っている。`)
}
