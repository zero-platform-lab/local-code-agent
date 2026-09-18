# PII 伏せ字の内部実装

個人情報の伏せ字が、送信のどこで・どう当たるかを、実装の側からまとめる。何を伏せるか・なぜ伏せるかは、機能仕様（[../features/pii-masking.md](../features/pii-masking.md)・[../features/pii-proper-nouns.md](../features/pii-proper-nouns.md)・[../features/pii-file-mapping.md](../features/pii-file-mapping.md)）にある。

## 送信経路の一点で伏せる

プロバイダの抽象は `ApiHandler`（`src/api/types.ts`）で、`createMessage(systemPrompt, messages, metadata)` を持つ。`buildApiHandler`（`src/api/index.ts`）が返すのは `openai` とテスト用の `fake-ai` だけで、OpenAI 互換以外のエンドポイントへは意図的につながない。実装は `src/api/providers/openai.ts` の `OpenAiHandler`。

1 リクエストを送るまでの流れは `src/core/task/apiRequestOrchestrator.ts` にある。

1. `getSystemPrompt()` でシステムプロンプトを組み立てる。
2. 文脈管理で必要なら切り詰める。
3. `buildRequestHistory` で保存履歴を送信用の列へ直す。
4. **`maskForRequest` で伏せ字化する**。ここが伏せ字の唯一の差し込み口である。
5. ツールと metadata を組み立てる。
6. **`api.createMessage(...)` で実際に送る**。

核心は「伏せるのは送る写しだけで、保存した履歴は利用者が書いたまま残す」ことである（`FR-PII-01`）。`maskForRequest` は `Task.piiMasker`（`TaskPiiMasker`）を `buildApiRequestDeps` で束ねて渡す。要約の経路（`src/core/condense/`）も同じ `maskForRequest` を通る。

## 伏せ字の本体（`src/services/pii/`）

- `TaskPiiMasker.maskForRequest`（`src/services/pii/TaskPiiMasker.ts`）。第 2 層の固有名詞検出を呼び、対応表を取り込み、`maskConversation` で伏せ、対応をファイルへ保存する。
- `maskConversation.ts`。採番と復元を持つ `PiiMapping`、会話をまたいで共有する `sessionMapping()`、実際に伏せる `maskConversation()`。
- 対応表 `fileMapping.ts` と、その永続化 `fileMappingStore.ts`。
- 検出は 2 層に分かれる。第 1 層は正規表現と辞書（`detectors.ts`・`dictionary.ts`）。第 2 層はモデルによる固有名詞検出（`ner*.ts`）。

## Claude Code 対応での流用

伏せ字は `maskConversation` を中心に、送信直前の `maskForRequest` の 1 か所へ集約されている。ここは transport（OpenAI 互換の送信）から切り離せるので、別の送信経路（Claude Code 向けのプロキシ）でも中核を流用できる。
