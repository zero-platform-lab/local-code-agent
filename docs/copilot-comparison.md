# GitHub Copilot との機能比較

このフォークを「何を削り、何を足すか」判断するための、**GitHub Copilot（VS Code の Chat /
エージェントモード）** との比較。同じ土俵＝「VS Code 内でファイルを読み書きし、コマンドを実行する
エージェント面」で対比する。Copilot コアの**インライン補完（ゴーストテキスト）**は、この拡張が
持たない別カテゴリなので前提として切り分ける。

出典は VS Code / GitHub 公式ドキュメント（下記）。**2026 年前半時点**。Copilot は更新が速いため、
具体は随時変わりうる。関連: [feature-inventory.md](feature-inventory.md)

---

## 比較表

| 領域                                | GitHub Copilot（VS Code）                                   | この拡張                                                   | 差                   |
| ----------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | -------------------- |
| エージェントの多段ループ            | agent mode                                                  | あり（再帰ループ）                                         | 同等                 |
| **自律実行**                        | **Autopilot**：自分で承認・エラー自動リトライ・完了まで無人 | auto-approval（手動トグル）＋ reasoning-off で早じまい問題 | **Copilot 有利**     |
| モデル選択                          | 複数（GPT / Claude / Gemini をピッカー）                    | **OpenAI 互換1本**（Azure / OpenAI GPT-5.x）               | 設計方針の違い       |
| インライン補完（ゴースト）          | **あり（コア）**                                            | **なし**（エージェント専用）                               | 別カテゴリ           |
| Next Edit 提案                      | あり                                                        | なし                                                       | Copilot 有利         |
| ファイル編集                        | editFiles                                                   | apply_diff / write_to_file / edit 系                       | 同等                 |
| ターミナル                          | terminal / runCommands                                      | execute_command / read_command_output                      | 同等                 |
| **テスト実行**                      | runTests（カバレッジもエージェントに報告）                  | 専用ツール無し（execute_command 経由）                     | **Copilot 有利**     |
| 診断 / エラー取得                   | problems ツール                                             | env details に含むが専用「get errors」無し                 | やや不足             |
| Web 取得                            | fetch                                                       | web_fetch（0.8.2 で opt-in）                               | 同等                 |
| **Web 検索**                        | あり（#fetch / 検索）                                       | **web_search 無し**                                        | **不足**             |
| コードベース意味検索                | #codebase（要インデックス）                                 | codebase_search（opt-in 埋め込み）                         | 同等（既定オフ）     |
| MCP                                 | あり（+ サンドボックス, マーケット）                        | あり（McpHub）                                             | Copilot が上物豊富   |
| カスタムエージェント / モード       | Custom agents（`.agent.md`・model + tools + MCP を束ねる）  | モード5種 + customModes                                    | 概念は近い           |
| スキル / プラグイン                 | Skills & plugins（マーケット・統合エディタ）                | skills（`.agent/skills`・手動）                            | Copilot が上物豊富   |
| スラッシュ / prompt                 | prompt files, /commands                                     | run_slash_command（/init + `.agent/commands`）             | 同等                 |
| カスタム指示                        | `copilot-instructions.md` 等                                | customInstructions / `.agent/rules`                        | 同等                 |
| サブエージェント                    | subagents                                                   | new_task（サブタスク）                                     | 近い                 |
| チェックポイント / 巻き戻し         | keep / undo                                                 | checkpoints（shadow git）                                  | 同等                 |
| コードアクション                    | explain / fix 等                                            | explainCode / fixCode / improveCode                        | 同等                 |
| 診断支援                            | `/troubleshoot`（エージェントログ解析）                     | `[API]` ログ + トラブルシュート docs                       | 手動                 |
| PR レビュー / クラウド coding agent | あり                                                        | なし                                                       | 対象外（別スコープ） |

---

## 読みどころ

### Copilot にあってこちらに無い（＝作る候補）

- **web_search**（URL ではなく質問から始めるリサーチ）。
- **runTests / get-errors 相当の専用ツール**（今は execute_command 経由）。
- **Autopilot 型の自律**。ただしこれは新機能というより、**既存の reasoning-off による早じまいを是正**
  すれば大きく近づく（chat/completions で reasoning を戻せるか、または Responses API 経路、
  初回プランニング）。
- インライン補完・Next Edit は**別カテゴリ**で、この拡張の狙いではない（作らない前提でよい）。

### こちらの立ち位置

- **単一プロバイダ特化（Azure ＋社内 proxy）**が強み。Copilot の「モデル選択・マーケット・統合
  エディタ」は上物が厚いが、この用途には過剰。
- **自律性で見劣り**するのは Autopilot 対比。新規実装よりも既存挙動の是正で埋まる部分が大きい。

---

## 出典

- [Copilot agent mode + MCP（GitHub Blog）](https://github.blog/news-insights/product-news/github-copilot-agent-mode-activated/)
- [Agent mode 101（GitHub Blog）](https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/)
- [Custom agents in VS Code](https://code.visualstudio.com/docs/agent-customization/custom-agents)
- [Use tools in chat（VS Code）](https://code.visualstudio.com/docs/copilot/agents/agent-tools)
- [Build with agents in VS Code](https://code.visualstudio.com/docs/agents/overview)
