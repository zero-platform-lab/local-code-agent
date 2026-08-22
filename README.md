# Local Code Agent

ローカル環境の OpenAI 互換エンドポイント（vLLM / Ollama / TGI）・Azure OpenAI に接続する AI コーディングエージェント。

### コード解析の対応言語

エージェントがコード構造（定義抽出・コードベース索引）を解析できる言語は以下です（tree-sitter）。ここに無い言語は解析されないだけで、通常の編集・実行は可能です。

`bash` `c` `c++` `c#` `css` `go` `html` `java` `javascript` `json` `kotlin` `php` `python` `ruby` `rust` `scala` `swift` `toml` `tsx` `typescript` `vue` `yaml` （＋ EJS 等テンプレート）

対応言語を増やす場合は `packages/build/src/esbuild.ts` の `SUPPORTED_TREE_SITTER_LANGUAGES` に追加してください。

---

## 目次

1. [インストール](#インストール)
2. [OpenAI 互換エンドポイントの接続設定](#openai-互換エンドポイントの接続設定)
3. [Azure OpenAI の接続設定](#azure-openai-の接続設定)
4. [ソースからビルド](#ソースからビルド)
5. [外部通信の制限](#外部通信の制限)
6. [セキュリティ上の注意事項](#セキュリティ上の注意事項)
7. [免責事項](#免責事項)
8. [トラブルシューティング](#トラブルシューティング)
9. [ライセンス](#ライセンス)

---

## インストール

```bash
code --install-extension openai-agent-<version>.vsix
```

アクティビティバーに「Local Code Agent」のアイコンが表示されます。  
インストール後は VS Code の再起動を推奨します。

### アンインストール

```bash
code --uninstall-extension internal.openai-agent
```

---

## OpenAI 互換エンドポイントの接続設定

### 前提

LLM サーバが OpenAI 互換の `/v1/chat/completions` エンドポイントを公開していること。

| サーバ種別 | Base URL の例                |
| ---------- | ---------------------------- |
| vLLM       | `http://llm-server:8000/v1`  |
| Ollama     | `http://llm-server:11434/v1` |
| TGI        | `http://llm-server:8080/v1`  |

### 設定手順

1. アクティビティバーの「Local Code Agent」アイコンをクリック
2. 以下を入力:

| 設定項目     | 入力値                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| **Base URL** | `http://<ホスト>:<ポート>/v1`                                                           |
| **API Key**  | サーバが API Key を要求する場合はその値。不要な場合は任意の文字列（例: `not-required`） |
| **Model ID** | サーバが提供するモデル名（例: `meta-llama/Llama-3.1-70B-Instruct`）                     |

3. **Done** をクリック。チャット欄にメッセージを入力してレスポンスが返れば接続成功。

> [!NOTE] > **接続先は `settings.json` では設定できません。** Base URL / API Key / Model ID は
> プロバイダプロファイルとして拡張側のストレージ（API Key は SecretStorage）に保存され、
> VS Code の設定値ではありません。設定は上記の Settings 画面か、環境変数 `OPENAI_BASE_URL` から行ってください。
>
> `settings.json` に置ける `openai-agent.*` は、`contributes.configuration` にある
> 実行制御系のキー（`allowedCommands` / `deniedCommands` / `commandExecutionTimeout` など）
> だけです。

---

## Azure OpenAI の接続設定

Azure OpenAI Service のエンドポイントにも対応しています。

### 設定手順

1. **API Provider** → **OpenAI Compatible / Azure OpenAI** を選択
2. 以下を入力:

| 設定項目     | 入力値                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| **Base URL** | `https://<リソース名>.openai.azure.com/openai/deployments/<デプロイ名>` |
| **API Key**  | Azure ポータルで取得した API キー                                       |
| **Model ID** | デプロイメント名（例: `gpt-4o`）                                        |

3. **Use Azure OpenAI** トグルを **ON** にする
4. **Azure API Version** にバージョンを入力（例: `2024-12-01-preview`）

### Azure AI Inference の場合

| 設定項目     | 入力値                                              |
| ------------ | --------------------------------------------------- |
| **Base URL** | `https://<リソース名>.services.ai.azure.com/models` |
| **API Key**  | Azure ポータルで取得した API キー                   |
| **Model ID** | デプロイメント名                                    |

※ Base URL のドメインが `.services.ai.azure.com` であれば自動認識されます。

---

## ソースからビルド

### 前提条件

- Node.js 20.x
- pnpm 10.8.1（`corepack enable pnpm && corepack prepare pnpm@10.8.1 --activate`）

### ビルド手順

```bash
pnpm install
pnpm clean
pnpm vsix:internal
ls -lh bin/openai-compatible-agent-*.vsix
```

---

## 外部通信の制限

本ビルドでは以下の外部通信を制限しています。

1. **起動時の自動モデルリスト取得を無効化**  
   オリジナルでは起動時に外部サービスへモデル一覧を取得しに行きますが、本ビルドではこの処理を無効化しています。

2. **Webview の CSP（Content Security Policy）を最小化**  
   外部ドメインへの接続許可を除去しました。Webview は拡張自身のリソースのみ読み込みます。

3. **残存する通信**  
   ユーザが明示的に設定した LLM エンドポイントへの API 呼び出しのみ発生します。

---

## セキュリティ上の注意事項

本拡張はエージェント型 AI コーディングツールです。利用にあたり以下のリスクを理解してください。

### 1. コマンド実行

エージェントはユーザの許可を得てターミナルコマンドを実行できます。  
LLM レスポンスやファイル内のプロンプト注入によって意図しないコマンドが実行されるリスクがあります。

**対策:**

- `openai-agent.allowedCommands` でホワイトリスト運用する
- `openai-agent.deniedCommands` で危険なコマンドをブロックする
- コマンド実行時の確認ダイアログを必ず確認する

### 2. ソースコードの LLM 送信

エージェントはワークスペース内のファイルを読み取り、プロンプトの一部として LLM に送信します。

**対策:**

- LLM サーバがネットワーク内で完結していることを確認する
- 秘匿情報（API キー、パスワード）をソースコードに直書きしない
- `.gitignore` に含まれるファイルもエージェントは読み取れることに留意する

### 3. ファイル編集

エージェントはワークスペース内のファイルを直接編集します。  
自動承認モードでは確認なしに編集が行われます。

### 4. MCP サーバ連携

MCP サーバを接続すると外部ツールの機能をエージェントに追加できますが、  
信頼できない MCP サーバの接続は**任意コード実行と同等のリスク**があります。

### 5. API キーの保管

API キーは VS Code の SecretStorage に保存されますが、ユーザのマシン上に保持されます。

---

## 免責事項

本ソフトウェアは Apache License 2.0 に基づき「現状のまま（AS IS）」で提供されます。  
明示・黙示を問わず、商品性や特定目的への適合性を含め、いかなる保証もありません。

本拡張の利用により発生した以下の事象について、開発者・配布者は一切の責任を負いません。

- LLM が生成したコード・コマンドの実行による損害
- ソースコードや機密情報の LLM エンドポイントへの送信
- エージェントによるファイルの意図しない編集・削除
- MCP サーバ連携に起因するセキュリティインシデント

利用者は上記リスクを理解したうえで、自己の責任において本拡張を使用してください。

---

## トラブルシューティング

### API レスポンスが返ってこない

1. **ネットワーク疎通の確認**

    ```bash
    curl -v http://llm-server:8000/v1/models
    ```

2. **ストリーミングレスポンスの確認**

    ```bash
    curl -N -X POST http://llm-server:8000/v1/chat/completions \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer <your-key>" \
      -d '{"model":"<model-id>","messages":[{"role":"user","content":"hello"}],"stream":true}'
    ```

3. **VS Code の出力パネルで確認**  
   `表示` → `出力` → ドロップダウンから `Local-Agent` を選択（内部ビルド。通常ビルドは `Agent`）

4. **よくある原因**

    | 症状                     | 原因                                  | 対処                             |
    | ------------------------ | ------------------------------------- | -------------------------------- |
    | `Connection refused`     | サーバが起動していない / ポートが違う | URL とポートを確認               |
    | `401 Unauthorized`       | API Key が違う                        | 正しい API Key を設定            |
    | `404 Not Found`          | Base URL のパスが違う                 | `/v1` が含まれているか確認       |
    | `timeout`                | モデルのロード中 / サーバ過負荷       | サーバ側のログを確認             |
    | レスポンスが途中で切れる | `max_tokens` が小さい                 | モデル設定の Max Tokens を増やす |

### 拡張が表示されない

```bash
code --list-extensions | grep openai-compatible-agent
```

---

## ライセンス

本ソフトウェアは [Roo Code](https://github.com/RooCodeInc/Roo-Code)（Apache License 2.0 © 2025 Roo Code, Inc.）を改変したものです。  
オリジナルの LICENSE ファイルは本パッケージに同梱されています。
