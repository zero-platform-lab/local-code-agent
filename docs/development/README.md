# 開発ドキュメント

本製品（`openai-agent`）の内部実装を、開発者向けにまとめる。要件（[../requirements.md](../requirements.md)）と機能仕様（[../features/README.md](../features/README.md)）が「何を・なぜ」を扱うのに対し、ここは「どう作られているか」を扱う。

## 目次

- [architecture.md](architecture.md) — 全体像。動作原理・リポジトリ構成・リクエストループ・core/task の内部・ビルドと品質ゲート。
- [pii.md](pii.md) — PII 伏せ字の内部実装。送信経路の一点（`maskForRequest`）と、その中核。Claude Code 対応でも流用できる。
- [webview.md](webview.md) — 拡張と Webview（React）の連携。
- [mcp.md](mcp.md) — MCP 連携。
- [diff-and-checkpoints.md](diff-and-checkpoints.md) — 差分プレビューとチェックポイント。
