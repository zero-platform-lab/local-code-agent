# AGENTS.md

このリポジトリで作業するエージェント向けの指針である。プロジェクト固有の事実はここに置き、
個人・マシン固有のメモは `AGENTS.local.md`（gitignore 対象）に置く。

## このプロジェクトは何か

**OpenAI Compatible Agent** — Roo Code（Apache-2.0）の機能限定フォークで、**独立リポジトリ**
として維持している（live fork ではない。履歴は squash 済み）。VS Code 拡張であり、エージェントの
接続先は **OpenAI 互換エンドポイント（vLLM / Ollama / TGI）と Azure OpenAI のみ**。他の LLM
プロバイダのバックエンドはスタブ化ではなく削除した。

チャットのメインビューは GitHub Copilot / Codex と同様に**セカンダリサイドバー**（右側）に
配置している。

## リポジトリ構成（pnpm workspaces + turbo）

- `src/` — 拡張ホスト。workspace パッケージ名は `openai-agent`。
- `webview-ui/` — React 製 Webview（`@openai-agent/vscode-webview`）。
- `packages/types/` — 共有型と zod スキーマ（`@openai-agent/types`）。
- `packages/core`、`packages/build`、`packages/ipc`、`packages/config-*`。
- `apps/vscode-internal/` — `.vsix` を生成する**内部ブランドの配布ビルド**。
- `apps/vscode-e2e/` — `@vscode/test-electron` によるエンドツーエンドテスト。

## ビルド・テスト・パッケージング

- **型検査:** `pnpm run check-types`（turbo・全パッケージ）。pre-push が実行するのはこれ。
- **lint:** `pnpm turbo lint`（eslint `--max-warnings=0`。警告も失敗になる）。
- **ユニットテストは vitest を持つパッケージから実行する。リポジトリルートからは実行しない:**
    - 拡張ホスト: `cd src && npx vitest run <src からの相対パス>`（先頭に `src/` を付けない）。
    - Webview: `cd webview-ui && npx vitest run src/<パス>`。
    - types: `cd packages/types && npx vitest run src/<パス>`。
- **カバレッジ基準: 触ったファイルは C0（命令網羅）100% ではなく C1（分岐網羅）100% に到達させる。**
    - リポジトリ全体の下限はゲートが強制する: 各パッケージの `vitest.config.ts` に
      `coverage.thresholds` があり、`pnpm ci:local` が `pnpm test:coverage` を実行する。この数値は
      ラチェット（後退を防ぐための現在値）であって基準ではない — 基準は上記の C1 100% である。
      下限の引き上げは歓迎、引き下げには理由が要る。
    - 測定は変更したファイルに対して行う（リポジトリ全体ではない）。上記の vitest コマンドに
      `--coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include='<file>'`
      を付ける。
    - 呼び出し契約上どの入力でも到達できない作者記述の分岐（ソース上に実在する `if`/`?:`/`??`）は
      `/* v8 ignore next -- 到達不能: <理由> */` で除外してよい。`!` アサーションに変えるのではなく
      安全な既定値（`?? ""` / `?? []`）を残す — 不変条件が崩れたときに安全側へ倒れる。人工分岐と
      同じ厳密さで到達不能性を証明すること（アノテーションの有無で分岐総数が変わらず、covered だけが
      増える）。到達可能な分岐は必ずテストする。
    - 除外は 3 種類のみで、いずれもコメント必須: 到達不能なデッドコード / 等価な変異（どの入力でも
      差が観測できない）/ **人工分岐**（コンパイラ・エンジンが生成したもので、ソースに `if` や三項が
      なく、どのテストも到達できない。例: `catch` がすべてを握りつぶす `try/catch/finally` に V8 が
      生成する幻の分岐）。最後のケースに限り
      `/* v8 ignore next -- 人工分岐: <理由> */` を付ける。作者記述の実在する分岐を隠すために使っては
      ならない — それらはテストする。付ける前に人工であることを証明する: アノテーションの有無で
      分岐総数が変わらないこと（covered が 1 増えるだけ）。
    - **数値の達成は成果物ではない。**カバレッジは行が実行されたことを示すだけで、壊れたときに
      検出できることは示さない。提出前にプロダクションコードへ手で 2〜3 個の変異を入れ、テストが
      実際に落ちることを確認する（確認後に戻す）。どのテストも捕まえない変異は、埋めるべき穴か
      等価な変異かのどちらかである — どちらかを判断して書き残す。
    - 根拠の全文と不変条件ファーストの考え方: `.agent/rules/rules.md`。
- **配布物のビルド:** `pnpm bundle:internal`（esbuild）→ `pnpm vsix:internal`
  （vsce → `bin/openai-compatible-agent-<version>.vsix`。リリースビルドは
  `pnpm vsix` → `bin/openai-agent-<version>.vsix`）。
- **フック:** pre-commit = ステージ済みファイルへの lint + prettier（`--max-warnings=0`）。
  pre-push = `check-types` と main への直接 push の禁止（ブランチ + PR で行う）。

## ブランディング / 識別子（重要・壊しやすい）

- `Package.name = process.env.PKG_NAME || name`（`src/shared/package.ts`）。コマンドとビューは
  実行時に `${Package.name}.<id>` として登録される。
- 内部ビルド（`apps/vscode-internal/esbuild.mjs`）は `PKG_NAME=openai-compatible-agent` を設定し、
  生成する `package.json` 全体で **`openai-agent` → `openai-compatible-agent` に置換する**。
  ソース上の contributes は `openai-agent.` プレフィックスを使う。
- **`package.json` の contribution ID は実行時の `${Package.name}.<id>` と一致していなければ
  ならない。**不一致は「command not found」・押しても反応しない設定ボタン・初回起動ループとして
  現れる。`packages/build` のガードテストがこの一致を検証している。

## 苦労して学んだ落とし穴

- **`packages/types/dist` の陳腐化:** 型検査とユニットテストは TS ソースを解決する
  （`exports.import`）が、e2e と CJS は ビルド済みの `dist` を `require` する。types を変更したら
  `pnpm --filter @openai-agent/types build` を実行しないと e2e が `Cannot find module` で落ちる。
- **テストはネットワークを遮断している:** `src/vitest.setup.ts` が `nock.disableNetConnect()` を
  呼ぶ。実エンドポイントを叩く統合テストは、エクスポートされている `allowNetConnect(host)` で
  対象ホストを再許可し、環境変数の背後に置く（`openaiConnection.live.spec.ts` を参照）。
- **配布ビルドは minify 必須:** `bundle:internal` は `--production` を渡す。これがないと
  `extension.js` が未圧縮で約 23 MB になり、起動（"Activating Extension"）が遅くなる。
- **`bundle:internal` / `vsix:internal` は `turbo.json` で `cache:false`。**別パッケージから
  `src/` を読むため、turbo の既定キャッシュでは古い（未圧縮の）出力が返っていた。
- **セカンダリサイドバーのキーは `secondarySidebar`**（`b` は小文字）で、
  `engines.vscode >= 1.106` が必要。誤った大文字小文字は黙って無視され、ビューはエクスプローラーに
  落ちる。
- **UI の実機確認:** `apps/vscode-e2e` + Xvfb で
  `--extensionDevelopmentPath=apps/vscode-internal/build` を指定して実際の VS Code を起動できる。
  スクリーンショットは `import -window root`。
- **設定ビュー:** 入力はライブの `useExtensionState()` ではなくローカルの `cachedState` に
  バインドされる。編集は「保存」が `ContextProxy`（信頼できる唯一の情報源）へ書き込むまで
  バッファされたままになる。

## 方針と既定の決定事項

- **自律モード**（Manual / Auto-Edit / Auto / Plan）がある — Claude Code 型の権限モードで、
  役割モードとは別物。`packages/types/src/autonomy.ts` で定義し、`ClineProvider.setAutonomyMode`
  が適用する。Plan の読み取り専用ガードは `src/core/tools/validateToolUse.ts`。
  自律レベルは**ユーザーのみが制御する**。モデルが自分でレベルを上げてはならない。
- **役割モード**（Code/Architect/Ask/Debug/Orchestrator）は **Code のみ**への削減と
  `switch_mode` ツールの削除を予定している（未着手。影響範囲が大きい）。
- **削除の基準:** 「削除」とは構造体を**その呼び出し元もすべて含めて**取り除くこと。スタブを
  残してはならない。完全性は独立した監査で検証する。
- **完了は外部で証明する:** 自分の「終わった感」で完了を報告しない。検証の出力（テスト・型検査・
  実際の実行）で裏付ける。それがなければ完了ではない。

## 文書規約（レビューから得た教訓）

`docs/architecture.md` のエキスパートレビューと校正のサイクルから抽出した規則である。
このリポジトリで書く・改訂するすべての文書に適用する。

**正確さ — 数えられる主張はすべてコードで裏を取る:**

- **正準のソース**で数える。ディレクトリの一覧では数えない。「ツール 28」は `core/tools/` の
  `.ts` ファイル数（`BaseTool` やヘルパーを含む）で、実際の数は `packages/types/src/tool.ts` の
  `toolNames` だった。同じ罠: `.tsx` ファイル数 ≠ コンポーネント数。
- 「すべての X は Y を通る」という主張は**経路ごとに**検証する。「全 outbound は
  `getProxyDispatcher()` を通る」は誤りだった: リモート MCP（SSE/StreamableHTTP）は素の `fetch`
  を使う。
- 隔離を主張するときはオプトインの例外を列挙する（「外部通信は LLM のみ」には「…加えて明示的に
  有効化した場合の web_fetch / リモート MCP」が要る）。
- 廃止済みの機能を現行として書かない（例: 削除済みの `browser` ツールグループ）。

**枠組み — 古い文書から引き継がない:**

- コードが**何であるか**を平易な言葉で書く。上流の文書がどう呼んでいたかではない
  （「monorepo」は、pnpm workspaces で分割されているだけの単一製品リポジトリを過大に表現していた）。
- 現状の記述と評価を分ける。意見（「この分割は過剰」）は明確にラベル付けした備考の節に置き、
  深刻度を正直に書く — 保守コスト程度の話であって不具合ではないなら、そう明記する。
- 各数値の記載箇所は 1 つに限る。重複した数値は独立に古びて腐る。

**日本語の文体（技術文書）:**

- 常体（〜である）で統一。読者への呼びかけ（「あなた」）や比喩（頭脳・司令塔・門番・水際）は使わない。
- 主述のねじれを許さない（例:「API エラーは再試行し」→「API エラーが発生した場合は再試行し」）。
- 直訳調・造語を避ける: 押し戻す→送り返す、束ねる→バンドルする、実起動→実際に起動、
  文脈→コンテキストウィンドウ、裏の git→シャドウ git。
- 表記を統一する: 用語は 1 対象 1 語（ループ/サイクルを混在させない）、「〜等」でなく「〜など」、
  中黒「・」は名詞の並列のみ、和文に生の英語（opt-in）を混ぜない、「（＝X）」でなく「（X と呼ぶ）」。
- 節参照・数字は裸にしない（「6 で判定」→「ステップ 6 で判定」、「§1」→「§01」）。

**構成と図:**

- アーキテクチャ文書は二部構成にする: 概要（前提知識を要求しない）→ 内部実装（開発者向け）。
  アンカー付きの目次を付ける。
- 図の文法を宣言する: 矢印の向き（依存の矢印は依存される側を指す）、色の凡例、そして各図の
  キャプションで辺が何を意味するかを述べる。
- シーケンス図で、同一プロセス内の関数群を独立プロセスであるかのように描くなら、必ずその旨を
  明記する。

## セキュリティスキャン（ローカル・開発時のみ）

いずれもローカルの開発ツールであり、`.vsix` には**含まれない**。

- **eslint-plugin-security**: `pnpm lint:security`（独立した `eslint.security.config.mjs`。
  strict ビルドの lint からは外している）。再現率は高いが精度は低い —
  `detect-object-injection` / `detect-non-literal-fs-filename` はほぼノイズ。
  `detect-unsafe-regex` / `detect-non-literal-regexp` に注目する。
- **Semgrep**（シグナルが強い）: venv に一度インストールし、
  `semgrep --config p/security-audit --config p/javascript --config p/typescript --metrics off --oss-only src webview-ui/src`
  を実行する（`--config auto` はメトリクス送信が必要。オフライン・プライベートな実行では明示的な
  ルールセットを使う）。
- **依存の脆弱性**: `pnpm audit --prod`。ツリーの大半は推移的・ビルド専用で配布物には入らない。
  実行時に関係するのは `shell-quote`（コマンド解析）と `simple-git`（checkpoints）。

## CI はローカル — GitHub Actions を復活させない

これは**プライベート**リポジトリであり、Actions の実行時間は課金対象になる。2026-07-26 以降、
GitHub 上に CI は一切なく、品質ゲートは開発者のマシンで実行する。

- **`pnpm ci:local`** は、削除した `code-qa.yml` が実行していた 8 項目（install・i18n・knip・
  format・lint・check-types・lint:cycles・unit test）を約 2 分で実行する。`--fast` はテストを
  スキップし、**`--strict`** は `pnpm install --frozen-lockfile` を追加して `TURBO_FORCE=true` を
  設定する。
- **push 前は `--strict` を使う。**これがないと `lint` と `check-types` が 0 秒の `cache hit` で
  返り、実際には再検査されない — サマリ行にもそう表示される。
- **削除したもの:** `.github/workflows/code-qa.yml` と `codeql.yml` は `3008d0d37` で、
  `.github/dependabot.yml` は `ab093967f` で完全に削除した。CodeQL は週次の `schedule` cron を持ち、
  code-qa は `windows-latest` のマトリクスジョブ（プライベートリポジトリでは 2 倍の課金係数）を
  実行していた。`renovate.json` は残しているが `"enabled": false`。
- **再作成しないこと。**課金を止めるために意図して削除したのであって、事故ではない。リリースで
  本当にクリーンルーム実行が必要になったら、`on: workflow_dispatch` のみで一時的に復元する —
  `push` / `pull_request` / `schedule` は決して使わない。
- `.github/actions/setup-node-pnpm` と `slack-notify` は現在未参照だが、ワークフローを復元する
  場合に備えて残している。
- 留意すべき影響: Windows を検証するものが無くなった。依存・脆弱性の更新も自動 PR では届かない —
  `pnpm audit --prod` は手動の作業になる。GitHub は Dependabot の**アラート**自体は引き続き
  報告する（2026-07-26 時点でデフォルトブランチに 5 件）。無くなったのは自動更新 PR だけである。

## 下位のルールとコマンド

具体的で現在も有効なルールは `.agent/` 配下にある。参照すること:

- `.agent/rules/`、`.agent/rules-code/`、`.agent/rules-debug/` — コーディング・テスト・デバッグの規則。
- `.agent/commands/` — `commit.md`、`release.md`（プロジェクトのワークフロー）。
