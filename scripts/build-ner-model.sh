#!/bin/sh
# 第 2 層（固有名詞の検出）のモデルを作る。
#
# 何をするか:
#   1. 公開されている PyTorch の重みを ONNX へ変換する
#   2. int8 へ量子化する
#   3. 実行に要る 5 つのファイルだけを集める
#   4. 1 つの書庫にまとめ、照合する値を出す
#
# なぜ要るか:
#   Node は PyTorch を実行できない。ONNX Runtime が読める形へ直す必要がある
#   （docs/features/pii-proper-nouns.md「なぜ変換するのか」）。
#
#   変換はバイト単位では再現しない。変換する仕組みの版が違うと結果がずれるので、
#   **出来たファイルそのものを配る**。この手順は、作り直すときと、元を確かめたい
#   ときのために残す。
#
# 使い方:
#   sh scripts/build-ner-model.sh [出力先]
#
#   この機械に python は要らない。docker だけで動く。
#   出来たものは GitHub Release の `model-ner-ja-vN` に添付する。
set -e

MODEL="tsmatz/xlm-roberta-ner-japanese"   # MIT。学習データは CC-BY-SA 3.0（ストックマーク）
OUT="${1:-build/ner-model}"
WORK="$OUT/work"

mkdir -p "$WORK"
OUT_ABS=$(cd "$OUT" && pwd)

cat > "$WORK/convert.sh" <<'INNER'
set -e
export HOME=/w/home HF_HOME=/w/home/hf
# pip が入れる実行ファイルは PATH に載らない。載せないと次の行で止まる。
export PATH="$HOME/.local/bin:$PATH"
# **版を固定する。** 固定しないと pip が extra の有無を探して版を遡り、時間がかかる
# うえに、どの版で作ったものかが分からなくなる。下は実際に変換できた組み合わせである。
pip install --quiet --no-cache-dir \
	optimum==2.1.0 optimum-onnx==0.1.0 onnx==1.22.0 onnxruntime==1.30.0 \
	torch==2.14.0 transformers==4.57.6 certifi==2026.7.22 sentencepiece
# ONNX への書き出しは optimum 本体ではなく optimum-onnx が持つ。入れないと
# `optimum-cli export onnx` が認識されない。
# certifi は明示する。版を固定すると依存としては入らず、モデルの取得が TLS の
# 証明書を見つけられずに失敗する。
optimum-cli export onnx --model "$MODEL_ID" --task token-classification /w/fp32
optimum-cli onnxruntime quantize --onnx_model /w/fp32 --avx2 -o /w/int8
INNER

echo "--- 変換する（初回は 1.1 GB の取得があるため時間がかかる）---"
docker run --rm --user "$(id -u):$(id -g)" \
	-e MODEL_ID="$MODEL" \
	-v "$OUT_ABS":/w -w /w python:3.11-slim sh /w/work/convert.sh

echo "--- 実行に要る 5 つを集める ---"
# sentencepiece.bpe.model は tokenizer.json と重複するので入れない。
DIST="$OUT_ABS/ner-ja"
rm -rf "$DIST"
mkdir -p "$DIST/onnx"
cp "$OUT_ABS/fp32/config.json" "$DIST/"
cp "$OUT_ABS/fp32/tokenizer.json" "$DIST/"
cp "$OUT_ABS/fp32/tokenizer_config.json" "$DIST/"
cp "$OUT_ABS/fp32/special_tokens_map.json" "$DIST/"
cp "$OUT_ABS/int8/model_quantized.onnx" "$DIST/onnx/"

echo "--- まとめて、照合する値を出す ---"
tar -czf "$OUT_ABS/ner-ja.tar.gz" -C "$OUT_ABS" ner-ja
(cd "$DIST" && find . -type f | sort | xargs sha256sum) > "$OUT_ABS/SHA256SUMS"
(cd "$OUT_ABS" && sha256sum ner-ja.tar.gz) >> "$OUT_ABS/SHA256SUMS"

echo
echo "出来た:"
ls -l "$OUT_ABS/ner-ja.tar.gz" "$OUT_ABS/SHA256SUMS"
echo
echo "GitHub Release の model-ner-ja-vN に、この 2 つを添付する。"
