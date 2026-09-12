# 機能仕様

[requirements.md](../requirements.md) が定めた要件を、どう満たすかを書く。
1 つのファイルが 1 つの領域を扱い、いずれも次の 6 節を持つ。

| 節               | 内容                                                 |
| ---------------- | ---------------------------------------------------- |
| 目的             | 満たす要件の識別子と、その内容                       |
| 方式             | そう作った理由。ほかの選び方を採らなかった理由       |
| 制約             | この作りで、できないと決めたこと                     |
| 危険なところ     | 変更で壊しやすい箇所。過去に壊した箇所               |
| 確かめ方         | どのテストが何を確かめているか                       |
| できていないこと | 要件を満たしていない箇所。**満たしたらここから消す** |

**実装の構造の説明はここに書かない。** 構造は
[architecture.md](../architecture.md)・[webview.md](../webview.md)・[mcp.md](../mcp.md)・
[diff-and-checkpoints.md](../diff-and-checkpoints.md) にある。ここに書くのは、
要件と実装を結ぶ判断である。

## 一覧

| 機能仕様                                     | 対応する要件           |
| -------------------------------------------- | ---------------------- |
| [agent-loop.md](agent-loop.md)               | `FR-LOOP-*`            |
| [tools.md](tools.md)                         | `FR-TOOL-*`            |
| [file-access.md](file-access.md)             | `FR-FILE-*`            |
| [editing.md](editing.md)                     | `FR-EDIT-*`            |
| [command-execution.md](command-execution.md) | `FR-CMD-*`             |
| [approval.md](approval.md)                   | `FR-APRV-*`            |
| [modes.md](modes.md)                         | `FR-MODE-*`            |
| [context.md](context.md)                     | `FR-CTX-*`             |
| [checkpoints.md](checkpoints.md)             | `FR-CKPT-*`            |
| [mcp-servers.md](mcp-servers.md)             | `FR-MCP-*`             |
| [code-index.md](code-index.md)               | `FR-IDX-*`             |
| [extension-points.md](extension-points.md)   | `FR-EXT-*`             |
| [provider.md](provider.md)                   | `FR-PROV-*`            |
| [network.md](network.md)                     | `FR-NET-*`             |
| [vscode-ui.md](vscode-ui.md)                 | `FR-UI-*`              |
| [tasks.md](tasks.md)                         | `FR-TASK-*` `FR-DAT-*` |
| [i18n.md](i18n.md)                           | `FR-I18N-*`            |

## 品質ゲートが満たす要件

次の要件は、製品の機能ではなく、開発の手順が満たす。手順そのものは `AGENTS.md` と
`scripts/ci-local.sh` にある。

| 満たす要件                                             | 内容                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `NFR-MNT-01` `NFR-MNT-01a` `NFR-MNT-01b` `NFR-MNT-01c` | 1 つのコマンドで全項目を実行する。途中で失敗しても最後まで進む。キャッシュを読まない手段を持つ |
| `NFR-MNT-02` `NFR-MNT-02a`                             | 変更したファイルの分岐網羅と、除外してよい 3 つの場合                                          |
| `NFR-MNT-03`                                           | 循環依存を増やさない                                                                           |
| `NFR-MNT-04` `NFR-MNT-04a`                             | 数えられる主張は正準の出所で数え、同じ数値を 2 か所へ書かない                                  |
| `NFR-MNT-05`                                           | 要件の識別子と件数を機械で確かめる                                                             |
| `NFR-MNT-06`                                           | 削除とは、呼び出し元も含めて取り除くことをいう                                                 |
| `NFR-SEC-13`                                           | 依存の脆弱性を手で確かめる手順を定める                                                         |

`NFR-MNT-05` を満たすのは `scripts/check-docs.mjs` である。次の 5 つを確かめる。

1. 機能仕様が書いた要件の識別子が、`requirements.md` に実在すること
2. `requirements.md` の要件が、4.2 の検証の表と、いずれかの機能仕様に載っていること
3. 下の「件数」の表と、ほかの文書に書いた件数が、一次ソースから数えた値と合うこと
4. **4.2 と機能仕様が引いたファイルが実在すること。** テストはディレクトリまで書くこと
5. 機能仕様が 6 節を備え、未解決の衝突の印が残っていないこと

**中身が要件に合っているかまでは見られない。** 4.2 が引いていたテストが、要件とは別の
ことを確かめていた例が実際にある（`FR-DAT-11`）。そこは人が読む。

## 件数

**人が数え直さない。** 下の件数は `scripts/check-docs.mjs` が一次ソースから数え直し、
食い違ったら失敗する。

| 対象                   | 件数 | 一次ソース                                                            |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| 要件                   | 319  | `docs/requirements.md` の 3 章                                        |
| 機能要件               | 266  | 同上                                                                  |
| 非機能要件             | 53   | 同上                                                                  |
| 機能仕様               | 17   | `docs/features/`                                                      |
| ツール                 | 23   | `packages/types/src/tool.ts` の `toolNames`                           |
| ツールグループ         | 5    | `src/shared/tools.ts` の `TOOL_GROUPS`                                |
| 常時利用のツール       | 6    | `src/shared/tools.ts` の `ALWAYS_AVAILABLE_TOOLS`                     |
| 役割モード             | 2    | `packages/types/src/mode.ts` の `DEFAULT_MODES`                       |
| 自律モード             | 4    | `packages/types/src/autonomy.ts` の `autonomyModes`                   |
| 既定で拒否するコマンド | 18   | `packages/types/src/autonomy.ts` の `DEFAULT_DENIED_COMMANDS`         |
| プロバイダ設定のキー   | 28   | `packages/types/src/provider-settings.ts` の `providerSettingsSchema` |
| グローバル設定のキー   | 75   | `packages/types/src/global-settings.ts`                               |
| VS Code の設定のキー   | 17   | `src/package.json` の `contributes.configuration`                     |
| コマンド               | 23   | `src/package.json` の `contributes.commands`                          |
| キーバインド           | 3    | `src/package.json` の `contributes.keybindings`                       |
| 設定のタブ             | 11   | `webview-ui/src/components/settings/SettingsView.tsx`                 |
| 実験的な機能           | 2    | `packages/types/src/experiment.ts`                                    |
