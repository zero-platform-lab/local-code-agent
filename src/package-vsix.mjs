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
import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const here = path.dirname(fileURLToPath(import.meta.url))

const target = process.argv[2]
if (!target || !/^[a-z0-9]+-[a-z0-9]+$/.test(target)) {
	console.error("使い方: node package-vsix.mjs <platform>-<arch>（例: linux-x64）")
	process.exit(1)
}

const [platform, arch] = target.split("-")
const env = { ...process.env, VSIX_TARGET: target }

const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: here, env, stdio: "inherit", shell: true })
	if (result.status !== 0) process.exit(result.status ?? 1)
}

run("pnpm", ["bundle", "--production", `--target=${target}`])
run("mkdirp", ["../bin"])
run("vsce", ["package", "--no-dependencies", "--target", target, "--out", "../bin"])

// **確かめる。** 束ね直しで platform が戻っていないか、出来たものから見る。
const version = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version
const vsix = path.join(here, "..", "bin", `openai-agent-${target}-${version}.vsix`)
const listed = spawnSync("unzip", ["-l", vsix], { encoding: "utf8" })

if (listed.status === 0) {
	const wanted = `napi-v6/${platform}/${arch}/`
	const others = listed.stdout.split("\n").filter((line) => /napi-v6\//.test(line) && !line.includes(wanted))

	if (!listed.stdout.includes(wanted) || others.length > 0) {
		console.error(`\n${vsix} に ${target} 以外のものが入っている:`)
		for (const line of others) console.error(`  ${line.trim()}`)
		process.exit(1)
	}
	console.log(`\n確認: ${target} の実行の仕組みだけが入っている。`)
}
