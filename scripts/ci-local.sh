#!/usr/bin/env bash
#
# ローカル CI ランナー。
#
# かつて .github/workflows/code-qa.yml が回していたチェックをローカルで実行する。
# private repo で Actions 分が課金されるため、ワークフローは削除済み（3008d0d37 / ab093967f）。
# GitHub 側に CI は無く、品質ゲートはこのスクリプトが担う。push 前に実行すること。
#
# 使い方:
#   pnpm ci:local             # 全チェック（turbo キャッシュ有効・約3分）
#   pnpm ci:local --fast      # unit test と e2e をスキップ
#   pnpm ci:local --strict    # CI 等価に寄せる: lockfile 検証 + turbo キャッシュ無視
#
# 検査内容: i18n / knip / prettier / eslint / tsc / 循環依存 / unit test (+網羅率の床) / e2e(smoke)
#
# e2e(smoke) は apps/vscode-e2e の**全テスト**を回す（鍵が要るものは置かない方針）。
# 単体テストでは決して捕まえられない層——
# manifest、view/コマンド登録、バンドル成果物、webview の起動、そして HTTP から
# タスクループまでの結線——を守るのが目的。内訳:
#   - extension.test.ts  … アクティベート → webview 起動 → コマンド登録
#   - round-trip.test.ts … フェイクの OpenAI 互換サーバ相手に 1〜2 往復
#                          （リクエスト送信 → SSE 解釈 → ツール実行 → 完了メッセージ）
#   - tool-effects.test.ts … 副作用のあるツールを実際に走らせる（write_to_file の書き込み、
#                          apply_diff の部分置換、new_task のサブタスク委譲と親への還流、
#                          execute_command の出力が会話へ戻ること）
#   - failure-paths.test.ts … 失敗したときの振る舞い（一時障害からの回復、落ち続ける
#                          ときの告知、diff 不一致でファイルを壊さないこと、
#                          非ゼロ終了コードがモデルへ戻ること）
# 初回だけ VS Code 本体（約 150MB）を apps/vscode-e2e/.vscode-test へダウンロードする。
# 実モデルを使うテスト（task / modes / subtasks / tools）はここには含めない。
# それらは apps/vscode-e2e/.env.local に鍵を置いて `test:run` で別途回す。
#
# 失敗しても最後まで走り、末尾にサマリを出す。1つでも失敗すれば exit 1。
#
# 旧 CI と一致しない点（--strict でも残るもの）:
#   - unit-test は ubuntu / windows のマトリクスだった。ローカルは実行中の OS のみ。
#   - Node は CI が 20.19.2 固定だった。ローカルは実行中の版（合わせるなら .nvmrc + nvm use）。
#   - CI はクリーンチェックアウト。ローカルは作業ツリー（未コミット分を含む）を検査する。

set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd="pnpm"
else
  pnpm_cmd="npx pnpm"
fi

# --strict: turbo のキャッシュを読まずに実行させる（--force 相当）。
# これが無いと lint / check-types が cache hit で 0 秒になり、実際には再検査されない。
if [ $STRICT -eq 1 ]; then
  export TURBO_FORCE=true
fi

names=()
results=()
durations=()
failed=0

run_step() {
  local name="$1"
  shift
  local start end status
  printf '\n\033[1;34m▶ %s\033[0m\n' "$name"
  start=$SECONDS
  "$@"
  status=$?
  end=$SECONDS
  names+=("$name")
  durations+=("$((end - start))")
  if [ $status -eq 0 ]; then
    results+=("PASS")
  else
    results+=("FAIL")
    failed=1
  fi
  return 0
}

# --strict のみ: CI は毎回 lockfile からインストールし直すので、その整合性を検証する。
# 依存の追加漏れ・lockfile の壊れは、これが無いとローカルでは検出できない。
if [ $STRICT -eq 1 ]; then
  run_step "install (--frozen-lockfile)" $pnpm_cmd install --frozen-lockfile
fi

# code-qa.yml: check-translations
run_step "i18n (find-missing-translations)" node scripts/find-missing-translations.js
# code-qa.yml: knip
run_step "knip" $pnpm_cmd knip
# prettier。--write ではなく --check なので、このゲートがファイルを書き換えることはない。
# リポジトリ全体を見る（除外は .prettierignore）。src / webview-ui / packages の中だけを
# 見る形にすると、実際にドリフトしていた scripts / docs / 各種設定ファイルを取り逃がす。
run_step "format" $pnpm_cmd format:check
# code-qa.yml: compile
run_step "lint" $pnpm_cmd lint
run_step "check-types" $pnpm_cmd check-types
run_step "lint:cycles" $pnpm_cmd lint:cycles
# code-qa.yml: unit-test。ゲートでは網羅率も一緒に測る。
# 各パッケージの vitest.config.ts に「床」を書いてあり、下回ると落ちる。
# 目標値ではなく後退防止のラチェット（現状値を固定したもの）。
if [ $FAST -eq 1 ]; then
  printf '\n\033[1;33m▶ unit test — --fast のためスキップ\033[0m\n'
else
  run_step "unit test (coverage)" $pnpm_cmd test:coverage
fi

# e2e（スモーク）。VS Code を実際に起動して拡張を読み込む。
# ヘッドレス環境（DISPLAY 無し）では xvfb-run 越しに走らせる。
run_e2e_smoke() {
  if [ -n "${DISPLAY:-}" ]; then
    $pnpm_cmd --filter @openai-agent/vscode-e2e test:smoke:ci
    return $?
  fi

  if command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a $pnpm_cmd --filter @openai-agent/vscode-e2e test:smoke:ci
    return $?
  fi

  printf '\033[31mDISPLAY が無く xvfb-run も見つからないため e2e を実行できない。\n' >&2
  printf 'Linux なら `sudo apt install xvfb`、GUI 環境なら DISPLAY を設定すること。\033[0m\n' >&2
  return 1
}

if [ $FAST -eq 1 ]; then
  printf '\n\033[1;33m▶ e2e (smoke) — --fast のためスキップ\033[0m\n'
else
  run_step "e2e (smoke)" run_e2e_smoke
fi

printf '\n\033[1m─── summary'
[ $STRICT -eq 1 ] && printf ' (strict)'
[ $FAST -eq 1 ] && printf ' (fast)'
printf ' ───\033[0m\n'
for i in "${!names[@]}"; do
  if [ "${results[$i]}" = "PASS" ]; then
    printf '  \033[32m✔ PASS\033[0m  %-34s %ss\n' "${names[$i]}" "${durations[$i]}"
  else
    printf '  \033[31m✘ FAIL\033[0m  %-34s %ss\n' "${names[$i]}" "${durations[$i]}"
  fi
done

if [ $STRICT -eq 0 ]; then
  printf '\n\033[2m※ turbo キャッシュ有効。0秒のステップは cache hit で再検査していない。\n'
  printf '   push 前など確実に検査したいときは --strict を使う。\033[0m\n'
fi

if [ $failed -ne 0 ]; then
  printf '\n\033[31mローカル CI 失敗。上記 FAIL を直してから push すること。\033[0m\n'
  exit 1
fi
printf '\n\033[32mローカル CI 全パス。\033[0m\n'
