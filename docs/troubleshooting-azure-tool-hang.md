# Azure GPT-5.x ツール時ハングの curl 切り分け

拡張（SDK）を挟まず **素の HTTP** で Azure を叩き、「拡張の問題か／endpoint・proxy の問題か」を分離する。
curl は SDK と同じ経路（HTTP）を通るので、curl でも同じように固まるなら原因は拡張の外（endpoint / proxy / モデルの仕様）にある。

> 落とし穴（Windows）: PowerShell の `curl` は `Invoke-WebRequest` の**別名**。**必ず `curl.exe`** を使う（Windows 10+ に同梱）。
> proxy は `HTTPS_PROXY` を設定すれば curl が自動で使う（明示するなら `-x "$HTTPS_PROXY"`）。

---

## 0. 変数を設定

### Linux / macOS (bash)

```bash
export AOAI_ENDPOINT="https://<resource>.openai.azure.com"   # 末尾に /openai は付けない
export DEPLOY="<deployment>"                                 # 例: gpt-5.6（デプロイ名）
export APIVER="2024-12-01-preview"
export AOAI_KEY="<api-key>"
export HTTPS_PROXY="http://<proxy-host>:<port>"              # 社内proxy。不要なら: unset HTTPS_PROXY
export URL="$AOAI_ENDPOINT/openai/deployments/$DEPLOY/chat/completions?api-version=$APIVER"
```

### Windows (PowerShell) — 実行は `curl.exe`

```powershell
$env:AOAI_ENDPOINT = "https://<resource>.openai.azure.com"
$env:DEPLOY        = "<deployment>"
$env:APIVER        = "2024-12-01-preview"
$env:AOAI_KEY      = "<api-key>"
$env:HTTPS_PROXY   = "http://<proxy-host>:<port>"    # 不要なら: Remove-Item Env:HTTPS_PROXY
$env:URL = "$($env:AOAI_ENDPOINT)/openai/deployments/$($env:DEPLOY)/chat/completions?api-version=$($env:APIVER)"
```

JSON ボディは**シングルクォート**で囲む。bash も PowerShell もシングルクォート内は素通しなので、下の各コマンドは**両OSで同じ JSON**が使える（違うのは変数の書き方 `$AOAI_KEY` ↔ `$env:AOAI_KEY` だけ）。

---

## 1. 切り分けリクエスト（上から順に）

各コマンドは `--max-time 60` 付き。**60 秒沈黙して `curl: (28) ... timed out` なら、その条件でハング再現**。
`-w` で末尾に `[http=<ステータス> total=<秒>]` が出る。

### A. baseline（tools 無し・非ストリーミング）— 疎通確認

bash:

```bash
curl -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":false}' "$URL"
```

PowerShell（`$AOAI_KEY`→`$env:AOAI_KEY`, `$URL`→`$env:URL`）:

```powershell
curl.exe -sS --max-time 60 -H "api-key: $($env:AOAI_KEY)" -H "content-type: application/json" `
  -w '\n[http=%{http_code} total=%{time_total}s]\n' `
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":false}' "$($env:URL)"
```

### B. tools 有り・**非ストリーミング・reasoning 無し** — 「tools 単独」で固まるか

bash:

```bash
curl -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":false,"tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"function","function":{"name":"read_file","description":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}' "$URL"
```

PowerShell: 同じ `-d '...'` を使い、`$AOAI_KEY`→`$($env:AOAI_KEY)`, `$URL`→`$($env:URL)`, 行継続を `` ` `` にする。

### C. tools 有り・**ストリーミング**（`-N` 付き）— SSE の最初のチャンクが来るか

bash:

```bash
curl -N -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":true,"tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"function","function":{"name":"read_file","description":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}' "$URL"
```

### D. tools + **reasoning_effort:"medium"**（旧・非対応の組み合わせ）— 400 か／ハングか

bash: C または B の `-d` に `"reasoning_effort":"medium"` を足す。例（非ストリーミング）:

```bash
curl -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":false,"reasoning_effort":"medium","tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"function","function":{"name":"read_file","description":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}' "$URL"
```

### E. tools + **reasoning_effort:"none"** + ストリーミング（= v0.7.16 が送る形）

bash:

```bash
curl -N -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":true,"reasoning_effort":"none","tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"function","function":{"name":"read_file","description":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}' "$URL"
```

### F. nullable 型配列の切り分け（B vs F）— v0.7.19 の対象

`B`（`type:"string"` 単一）は 200 なのに、実ツール（`execute_command` 等）は引数スキーマに
`type: ["string","null"]`（nullable 型配列）を持つ。これを endpoint/proxy が弾くと `400 (no body)`。
`B` と 1 箇所だけ違う（`path` の型を nullable 配列に）下記が **400 なら nullable が原因**、`200` なら無関係。

bash:

```bash
curl -sS --max-time 60 -H "api-key: $AOAI_KEY" -H "content-type: application/json" \
  -w '\n[http=%{http_code} total=%{time_total}s]\n' \
  -d '{"messages":[{"role":"user","content":"ping"}],"stream":false,"tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"function","function":{"name":"read_file","description":"read","parameters":{"type":"object","properties":{"path":{"type":["string","null"]}},"required":["path"]}}}]}' "$URL"
```

判定:

- **F が 400・B が 200** → nullable 型配列が原因（v0.7.19 が平坦化で対処）。
- **F も 200** → nullable は無関係。9 ツールの別要素が原因。次は「実ツールを 1 個ずつ足して二分探索」する。

---

## 2. 結果の読み方（どこで詰まるかで原因が割れる）

| 観測                                               | 意味／次の一手                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A が通る（200）が **B（tools・非stream）でハング** | tools 付きリクエスト自体が endpoint/proxy で止まる。**拡張では直せない層**（proxy 設定・deployment・モデル仕様）。→ proxy 管理者／Azure 側 |
| A・B は通るが **C（stream）でハング**              | proxy が **SSE をバッファ**して最初のチャンクを流していない。→ 拡張の**ストリーミングを OFF**で回避／proxy 設定                            |
| **D が 400**（body にエラー理由）                  | reasoning+tools の非対応が 400 で出るタイプ。理由文字列を確認。E（none）が通れば v0.7.16 の方向で正しい                                    |
| **E でもハング**                                   | reasoning でも streaming でもなく、tools 付き POST の到達性/応答が根本問題。B の結果と合わせて proxy/endpoint を疑う                       |
| **curl は通るのに拡張だけハング**                  | 拡張/SDK 層の問題（ヘッダ・タイムアウト・SSE パース等）。curl の成功リクエストと拡張の `[sent]` 診断を突き合わせる                         |
| どれも `curl: (28) timed out`                      | proxy 経由の到達性そのもの。`-v` を足してどこで止まるか（CONNECT/TLS/送信後）を見る                                                        |

補足フラグ:

- `-v` … 詳細（DNS/接続/TLS/送信/応答ヘッダ）。どの段階で止まるか分かる。
- `--max-time 60` を短く（例 20）すればハング判定が早い。
- proxy を明示するなら各コマンドに `-x "$HTTPS_PROXY"`（PowerShell: `-x "$($env:HTTPS_PROXY)"`）。
