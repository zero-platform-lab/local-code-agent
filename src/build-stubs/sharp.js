// `sharp` の代用。
//
// `@huggingface/transformers` は読み込みの時点で `sharp` を要求するが、これは画像を
// 扱うためのものである。本製品は第 2 層で文字しか渡さないので、中身は使わない。
//
// 本物を同梱すると 16.5 MB 増える（`@img` の platform ごとの実行ファイルを含む）。
// 代用に差し替えても文字の判定が動くことを確かめてある。
//
// 万一呼ばれたら例外にする。黙って空の値を返すと、画像を扱う経路が静かに壊れる。
function sharp() {
	throw new Error("画像は扱わない。sharp は同梱していない（docs/features/pii-proper-nouns.md）")
}

module.exports = sharp
module.exports.default = sharp
