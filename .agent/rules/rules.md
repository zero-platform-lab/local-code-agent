# Code Quality Rules

1. Test Coverage:

    - **基準: 触ったファイルは C1（分岐網羅）100%。** 新規ファイルも、既存ファイルに手を入れた場合も同じ。
      「行は通ったが分岐は片側だけ」を残さない。C0（命令網羅）100% は当然の前提で、そこで止めない
    - リポジトリ全体には**床**がある。各パッケージの `vitest.config.ts` の `coverage.thresholds` に
      現状値を書いてあり、`pnpm ci:local` の `unit test (coverage)` が下回ったら落とす。
      これは後退防止のラチェットであって目標ではない（目標は上の C1 100%）。
      引き上げは歓迎、引き下げは要相談
    - 例外は 3 つだけ。どれも**理由をコメントに書く**こと
        - 到達不能なデッドコード（どの入力でも通らないことを説明できるもの）。作者が書いた分岐
          （ソースに `if`/`?:`/`??` がある）で、呼び出し契約上どの入力でも踏めないものは、
          **`/* v8 ignore next -- 到達不能: <理由> */`** で除外してよい。安全のための防御既定
          （`?? ""` / `?? []` 等）は `!` で潰さず**残す**（不変条件が将来壊れたとき安全側に倒れる）。
          規約は人工分岐と同じ: 理由必須・1分岐単位・**実分岐を隠さない**・導入前に「注釈あり/なしで
          分岐総数が不変・covered が 1 だけ増える」を実測確認。踏める分岐は必ずテストする
        - 等価変異（変異させても観測可能な差が出ないもの。例: パーサが必ず string を返す箇所の `|| ""`）
        - **人工分岐**（コンパイラ/エンジンが生成した、ソースに `if`/三項が存在しない分岐で、
          どのテストでも踏めないもの）。代表例が `try/catch/finally` の finally: V8 は「例外が
          伝播中に finally を通過する」経路を合成分岐として数えるが、catch が全例外を握ると到達不能。
          この場合に限り、その分岐の直前に **`/* v8 ignore next -- 人工分岐: <理由> */`** を置く。
          規約:
            - `-- 人工分岐:` の後ろに理由を必ず書く（なぜ合成分岐か・なぜ潰せないか）
            - **自分が書いた実分岐を隠すのに使わない。** 未テストの実分岐は必ずテストする
            - 導入前に、その分岐が本当に人工分岐か実測で確かめる（注釈あり/なしで**分岐総数が変わらず**、
              covered が 1 だけ増えること＝実分岐を分母から消していないこと。実分岐を潰そうとすると
              実テストが落ちること）。`ShadowCheckpointService.ts` の finally がこの手順を踏んだ実例
    - リポジトリ全体の率は目標にしない。**変更した範囲**で測る。計測:
      `cd src && npx vitest run <spec> --coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include='<対象ファイル>'`
    - **数字を満たしただけで終わりにしない。** カバレッジは「テストが通った」ことしか示さず、
      アサーションが弱ければ何も検出しない。提出前に**製品コードへ意図的な変異を 2〜3 件入れ、
      テストが実際に落ちることを確認する**（確認後は必ず元に戻す）。落ちない変異があれば、
      それは埋めるべき穴か、等価変異かのどちらか。判断してコメントに残す
    - **何をアサートするかは「実装の形」ではなく「破ってはいけない条件」から決める。**
      壊れると取り返しがつかない操作（ファイルの書き込み・削除、コマンド実行、履歴の永続化、
      設定の書き換え）では、まず「**失敗したときに何もしないこと**」を固定する。
      例: 差分の適用に失敗したらファイルを触らない / 承認されるまで unlink しない /
      書き込みが失敗したら旧ファイルを消さない / 拒否されたらコマンドを 1 度も起動しない
    - **パスを組む箇所は、渡った全パスを検査する。** 識別子が外部由来（履歴 JSON、ユーザー入力、
      モデル出力）で `path.join` に入るなら、空文字・`..`・セパレータ・NUL を混ぜたケースを必ず置く。
      `fs.rm(recursive, force)` の対象が 1 階層上を指しても何も言わずに消える
    - Before attempting completion, always make sure that any code changes have test coverage
    - Ensure all tests pass before submitting changes
    - The vitest framework is used for testing; the `vi`, `describe`, `test`, `it`, etc functions are defined by default in `tsconfig.json` and therefore don't need to be imported from `vitest`
    - Tests must be run from the same directory as the `package.json` file that specifies `vitest` in `devDependencies`
    - Run tests with: `npx vitest run <relative-path-from-workspace-root>`
    - Do NOT run tests from project root - this causes "vitest: command not found" error
    - Tests must be run from inside the correct workspace:
        - Backend tests: `cd src && npx vitest run path/to/test-file` (don't include `src/` in path)
        - UI tests: `cd webview-ui && npx vitest run src/path/to/test-file`
    - Example: For `src/tests/user.test.ts`, run `cd src && npx vitest run tests/user.test.ts` NOT `npx vitest run src/tests/user.test.ts`

2. Lint Rules:

    - Never disable any lint rules without explicit user approval

3. Styling Guidelines:

    - Use Tailwind CSS classes instead of inline style objects for new markup
    - VSCode CSS variables must be added to webview-ui/src/index.css before using them in Tailwind classes
    - Example: `<div className="text-md text-vscode-descriptionForeground mb-2" />` instead of style objects
