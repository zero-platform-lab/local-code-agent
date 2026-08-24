---
description: "拡張機能の新しいリリースを作る"
argument-hint: patch | minor | major
mode: code
---

# リリース手順

**自動化されたリリースパイプラインは存在しない。** GitHub Actions は 2026-07-26 に
全廃済みで、`gh pr checks` は常に空を返す。以下は全て手動で実行する。
`pnpm ci:local --strict` が唯一のゲート。

changesets（`.changeset/`, `@changesets/cli`）は upstream Roo Code 由来の足場が
残っているだけで、この fork では一度も使っていない。バージョンは
`src/package.json` を直接編集する。

## 1. 前回リリースと変更内容を確認

```bash
gh release list --limit 5
git tag --sort=-v:refname | head -5

# 前回タグ以降にマージされた PR
git log --oneline $(git describe --tags --abbrev=0)..main
```

## 2. バージョンを決める

- **ベータ期間中は `0.x.y` を使う。** 0.x 自体が「未安定」を意味する。
- 正式版に上げる時点で `1.0.0` にする。1.0.0 は「安定版」の宣言なので、
  検証中のものに付けない。
- vsce の検証は `semver.valid()` なので `1.0.0-beta.1` のようなプレリリース表記でも
  `.vsix` は作れる（実測確認済み）。ただし本プロジェクトは 0.x 運用を採る。
- VS Code はバージョンが下がる更新を提示しない。番号を下げる場合は、
  利用者に手動アンインストール→再インストールが要ることをリリースノートに書く。

## 3. ブランチを切る

```bash
git checkout main && git pull
git checkout -b release/vX.Y.Z
```

## 4. バージョンと変更履歴を更新

- `src/package.json` の `version` を `X.Y.Z` に変更する。
  他の `package.json`（`apps/`, `packages/`）は拡張機能のバージョンとは無関係なので
  触らない。
- 変更内容は **GitHub Release のノート**に直接書く（`CHANGELOG.md` は廃止した）。
  `.vsix` には同梱しない。

ベータ版なら、節の先頭に「**ベータ版です。**」と明記する。

## 5. 検証（ここでは .vsix を作らない）

```bash
pnpm ci:local --strict     # 唯一のゲート。全ステップ PASS が必須
pnpm audit                 # 0 件を維持する。非ゼロなら止める
```

### 実エンドポイントとの相性を 1 回だけ確かめる

ゲートの e2e はフェイクの OpenAI 互換サーバ相手に回している。フェイクは
「こちらが理解した仕様」であって実物ではないので、SSE の刻み方や tool_calls の
分割が違うサーバでは繋がらない可能性がある。**リリース前に 1 回だけ実物で叩く。**

```bash
# 例: ローカルの Ollama（別ターミナルで起動しておく）
cd apps/vscode-e2e
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
OPENAI_MODEL_ID=gpt-oss:20b \
OPENAI_API_KEY=ollama \
  xvfb-run -a pnpm test:live
```

`[live] say=completion_result tool_call=true ...` が出れば、ツール呼び出しまで
含めて経路が通っている。モデルの応答待ちで 1〜3 分かかる。
`api_req_retry_delayed` が出た場合は相性の問題なので、そこで止めて原因を見る。

**この段階で `pnpm vsix` を実行してはいけない。** Release に添付する `.vsix` は
「タグが指すコミット」から作られるべきで、未 commit のワーキングツリーや
release ブランチから作ると tag と対応関係が取れない。生成物とタグの照合が壊れる。

もし「PR を出す前にビルド可能なことを確認したい」だけなら、生成物を捨てる:

```bash
pnpm vsix && rm -f bin/openai-agent-*.vsix
```

## 6. PR を出してマージ

```bash
git push -u origin release/vX.Y.Z
gh pr create --base main --title "chore(release): vX.Y.Z" --body "..."
gh pr merge <番号> --squash --delete-branch
```

## 7. タグを打つ

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

`.husky/pre-push` は push される ref を見て判定するので、main にいてもタグ push は
通る（PR #326）。ブロックされるのは `refs/heads/main` を更新する push だけ。

## 8. .vsix をビルド（ここが唯一のビルドポイント）

```bash
rm -f bin/*.vsix bin/*.sbom.cdx.json   # 古い成果物を必ず消してから
pnpm vsix                 # bin/openai-agent-X.Y.Z.vsix が出ること
pnpm sbom                 # bin/openai-agent-X.Y.Z.sbom.cdx.json が出ること
```

SBOM は OWASP の **cdxgen**（devDependency）が生成する CycloneDX 1.5 JSON である。
部品一覧に加えて**依存関係グラフ**を含み、生成時に JSON Schema 検証が走る
（cdxgen の `--validate` は既定で有効）。NTIA の「SBOM 最小要素」が求める項目を満たす
ため、自前生成ではなく標準ツールを使う。`--required-only` により本番依存だけを対象にする。

タグを打った直後の main HEAD からビルドする。手順 5 で作ったものを流用しないこと
（同じコミットから作れば bit-for-bit で一致することが多いが、依存や環境が変わると
ズレる可能性がある。「Release 添付の vsix はタグから作った」を不変条件に保つ）。

## 9. GitHub Release を作る

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --prerelease \                       # ベータ版なら必須
  --notes "..." \
  bin/openai-agent-X.Y.Z.vsix \
  bin/openai-agent-X.Y.Z.sbom.cdx.json
```

- リリースノートは**日本語**で書く。変更内容に加えて、インストール手順と
  検証結果（`pnpm audit` / `pnpm ci:local` / `.vsix` のサイズ）を添える。
- `.vsix` を必ず添付する。リポジトリは private なので、閲覧できるのは org
  メンバーのみ。
- ベータ版で `--prerelease` を付け忘れると安定版として表示される。

## 10. 確認

```bash
gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,assets
git rev-parse vX.Y.Z^{commit}   # main の HEAD と一致すること

# 同じコミットから再度ビルドしても bit-for-bit で同じになるべき（決定性チェック）
sha256sum bin/openai-agent-X.Y.Z.vsix
```

## 打ち直しが必要になったら

タグと Release を消してから作り直す。ダウンロード数を先に確認すること。

```bash
gh release view vX.Y.Z --json assets --jq '.assets[]|{name,downloadCount}'
gh release delete vX.Y.Z --yes --cleanup-tag   # remote タグも消える
git tag -d vX.Y.Z                              # ローカルタグ
```
