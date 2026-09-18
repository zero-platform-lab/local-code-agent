# 開発ドキュメント（全体像と主要な流れ）

## この文書について

この文書は、本製品（`openai-agent`）が**どう作られているか**を、内部実装を初めて読む人向けにまとめる。要件（`docs/requirements.md`）と機能仕様（`docs/features/`）が「何を・なぜ」を扱うのに対し、この文書は「どう」を扱う。

範囲は全体の構成と、主要な流れ（起動・エージェントループ・LLM 送信と伏せ字・webview 連携・ビルドとテストとリリース）に絞る。各部品の深掘りは、この文書からたどれる代表ファイルを起点に別途進める。対象は A（`openai-agent`）だけで、派生元の B（`copilot-pii-guard`）は扱わない。

本製品は Roo Code から派生した。コードに残る `Cline` という名前は、その名残である。

## 1. 全体の構成（monorepo）

pnpm のワークスペースで、次のように分かれる。

| 場所                                          | パッケージ名                    | 役割                                                                        |
| --------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `src/`                                        | `openai-agent`                  | 拡張本体。VS Code の manifest（`contributes`）と `dist/extension.js` を持つ |
| `webview-ui/`                                 | `@openai-agent/vscode-webview`  | 画面（React + Vite）。成果物は拡張へ取り込む                                |
| `packages/types/`                             | `@openai-agent/types`           | 共有の型と zod スキーマの源泉                                               |
| `packages/core/`                              | `@openai-agent/core`            | 実行環境に依存しない中核                                                    |
| `packages/ipc/`                               | `@openai-agent/ipc`             | 外部からエージェントへつなぐ IPC                                            |
| `packages/build/`                             | `@openai-agent/build`           | esbuild のユーティリティ                                                    |
| `packages/vscode-shim/`, `packages/config-*/` | 各種                            | 共有設定と shim                                                             |
| `apps/vscode-e2e/`                            | `@openai-agent/vscode-e2e`      | e2e テスト（mocha）                                                         |
| `apps/vscode-internal/`                       | `@openai-agent/vscode-internal` | 社内配布のビルド                                                            |

スクリプトは turbo でまとめて実行する（`turbo.json`）。型検査だけは `check-types` を `cache:false` にしている。webview の型検査が `src/shared` を跨ぐため、キャッシュすると型エラーを取り逃すからである。型と設定スキーマは `packages/types` が源泉で、`packages/types/src/global-settings.ts` に伏せ字の設定（`piiMaskingSchema`）も含む。

## 2. 起動（activation）

エントリは `src/extension.ts` の `activate()`。おおよそ次の順で組み立てる。

1. 出力チャネルと国際化、ターミナル登録を用意する。
2. `ContextProxy`（`src/core/config/ContextProxy.ts`）で設定と状態を読み込む。
3. ワークスペースごとに `CodeIndexManager` を背景で初期化する（起動をブロックしない）。
4. **`ClineProvider` を生成する**（`src/core/webview/ClineProvider.ts`）。webview とタスクを取りまとめる中核で、サイドバーのビューとして登録する。
5. `registerCommands` でコマンドを登録する（`src/activate/`）。
6. `registerPiiCommands` で右クリックの伏せ字機能を登録する。設定取得・明示復元・採番・第 2 層の検出の 4 つを注入する。
7. **`FileMappingController` を 1 つ生成し、`setFileMappingController` で共有登録する**。対応表（伏せ字と元の値の逆引き）の窓口を、拡張内で 1 つに保つ。
8. IPC 用の `API` を返す（`src/extension/api`）。

つまり起動時の中心は 3 つである。設定と状態の `ContextProxy`、webview とタスクの `ClineProvider`、対応表の `FileMappingController`。

## 3. エージェントループ

中核は `Task`（`src/core/task/Task.ts`）。`EventEmitter` を継承し、責務は `src/core/task/` の多数の小さなファイルへ分けている。

- `Task.recursivelyMakeClineRequests()` は薄い入口で、`runRecursiveClineLoop`（`src/core/task/runRecursiveClineLoop.ts`）へ渡す。
- `runRecursiveClineLoop` が while ループの本体で、スタックを取り出しながら 4 段で進む。中断の確認、`checkMistakeLimit`（同じ失敗を繰り返したら止める停止条件）、`prepareRequestCycle`（レート制限・環境情報・依頼の登録）、`runOneRequest`（1 リクエスト分）。
- `runOneApiIteration`（`src/core/task/runOneApiIteration.ts`）が 1 リクエストのストリーム処理をまとめ、`presentAssistantMessage`（`src/core/assistant-message/presentAssistantMessage.ts`）でモデルの出力を提示する。

ツールの実行はディスパッチ表 `toolDispatch`（`src/core/assistant-message/toolDispatch.ts`）で振り分ける。書き込み系（`write_to_file`・`apply_diff` など）はチェックポイントを取り、読み取り系（`read_file`・`execute_command` など）は取らない。実行の前に `askApproval`（`src/core/assistant-message/presentToolUse.ts`）で承認を求め、拒否ならその結果を返す。上限を超えた自動承認は `AutoApprovalHandler` が止める。ツールの基底は `BaseTool`（`src/core/tools/BaseTool.ts`）で、呼び出しは native tool calling だけを使う（XML 形式は廃止した）。

## 4. LLM 送信経路と伏せ字（Claude Code 対応の要）

プロバイダの抽象は `ApiHandler`（`src/api/types.ts`）で、`createMessage(systemPrompt, messages, metadata)` を持つ。`buildApiHandler`（`src/api/index.ts`）が返すのは `openai` とテスト用の `fake-ai` だけで、OpenAI 互換以外のエンドポイントへは意図的につながない。実装は `src/api/providers/openai.ts` の `OpenAiHandler`。

1 リクエストを送るまでの流れは `src/core/task/apiRequestOrchestrator.ts` にある。

1. `getSystemPrompt()` でシステムプロンプトを組み立てる。
2. 文脈管理で必要なら切り詰める。
3. `buildRequestHistory` で保存履歴を送信用の列へ直す。
4. **`maskForRequest` で伏せ字を当てる**。ここが伏せ字の唯一の差し込み口である。
5. ツールと metadata を組み立てる。
6. **`api.createMessage(...)` で実際に送る**。

核心は「伏せるのは送る写しだけで、保存した履歴は利用者が書いたまま残す」ことである（`FR-PII-01`）。`maskForRequest` は `Task.piiMasker`（`TaskPiiMasker`）を `buildApiRequestDeps` で束ねて渡す。要約の経路（`src/core/condense/`）も同じ `maskForRequest` を通る。

伏せ字の本体は `src/services/pii/` にある。

- `TaskPiiMasker.maskForRequest`（`src/services/pii/TaskPiiMasker.ts`）。第 2 層の固有名詞検出を呼び、対応表を取り込み、`maskConversation` で伏せ、対応をファイルへ保存する。
- `maskConversation.ts`。採番と復元を持つ `PiiMapping`、会話をまたいで共有する `sessionMapping()`、実際に伏せる `maskConversation()`。
- 対応表 `fileMapping.ts` と、その永続化 `fileMappingStore.ts`。
- 検出は 2 層に分かれる。第 1 層は正規表現と辞書（`detectors.ts`・`dictionary.ts`）、第 2 層はモデルによる固有名詞検出（`ner*.ts`）。

Claude Code 対応の観点では、この 1 点が効く。伏せ字は `maskConversation` を中心に、送信直前の `maskForRequest` の 1 か所へ集約されている。ここは transport（OpenAI 互換の送信）から切り離せるので、別の送信経路（Claude Code 向けのプロキシ）でも中核を流用できる。

## 5. webview 連携

やり取りする型は 2 つ。拡張から画面へ送る `ExtensionMessage` と、画面から拡張へ送る `WebviewMessage`。どちらも `@openai-agent/types` にある。

拡張側は `ClineProvider.setWebviewMessageListener` が受け側で、`webviewMessageHandler`（`src/core/webview/webviewMessageHandler.ts`）へ渡す。ここは `message.type` を鍵に、ドメインごとのハンドラ（`settings`・`task`・`mcp` など）へ振り分けるだけである。起動直後の状態の受け渡しだけは `webviewDidLaunch` に残る。

画面側は `vscode.postMessage`（`webview-ui/src/utils/vscode.ts`）で送り、`ExtensionStateContext`（`webview-ui/src/context/ExtensionStateContext.tsx`）で受け取った状態を混ぜ合わせる。

トグルから設定への反映は次のようにつながる。`SecretModeToggle` と `FileMappingToggle`（`webview-ui/src/components/chat/`）が `updateSettings` を送り、`settingsMessageHandlers.ts` の `updateSettings` が `contextProxy.setValue` で永続化する。伏せ字（`piiMasking.enabled`）と対応表（`piiMasking.fileMapping.enabled`）の入り切りは、この経路で保存する。

## 6. ビルド・テスト・リリース

- スクリプトは turbo でまとめる。`check-types`・`test`・`lint`・`lint:security`・`lint:cycles`、`bundle`、`vsix`、`sbom`、`check-docs`、`knip` など。
- 拡張本体は esbuild、画面は vite でビルドする。`.vsix` は `src/package-vsix.mjs` が universal・linux-x64・win32-x64 を作る。
- `sbom` は宣言からではなく、`.vsix` に実際に入ったモジュールから作る（`scripts/generate-sbom.js`）。
- テストは vitest。`vscode` はモックへ置き換え、カバレッジに床を設ける（下回ると落ちる）。e2e は `apps/vscode-e2e`（mocha）で、フェイクの OpenAI 互換サーバと往復し、ツールの副作用まで確かめる。
- CI はローカルで回す。品質ゲートは `scripts/ci-local.sh`（`pnpm ci:local`）。GitHub 側のワークフローは費用の都合で外してある。版上げは changeset を使う。

## 付録: 要件と実装の対応

伏せ字まわりのコードには、要件番号（`FR-PII-xx`）がコメントで添えてある。要件番号で grep すると、要件と実装の対応をたどれる。
