# God-object 分割 設計ドキュメント（ClineProvider / Task）

> [!NOTE] > **これは 2026-07 時点の計画の記録で、現状のコードとは一致しない。** 例えば
> `fetchToolsList` / `fetchResourcesList` / `fetchResourceTemplatesList` は
> `src/services/mcp/mcpClientQueries.ts` の `fetchServerTools` /
> `fetchServerResources` / `fetchServerResourceTemplates` に改名・抽出済み。
> 現状は `docs/ARCHITECTURE.md` を参照。

`src/core/webview/ClineProvider.ts` と `src/core/task/Task.ts` の2大 god-object を、
薄いコーディネータ（facade）＋責務ごとのサブシステムに分割するための設計方針。
2026-07 セッションで「機械的に切れる葉」を出し切った後の、次フェーズ（設計）の計画。

---

## 1. 現状（2026-07-26 更新）

| 対象                       | 行数 | 補足                                                  |
| -------------------------- | ---- | ----------------------------------------------------- |
| `ClineProvider.ts`         | 991  | 大半のサブシステムへ分割済み。残るのは facade 相当    |
| `Task.ts`                  | -    | `recursivelyMakeClineRequests` が中核ループとして残る |
| `webviewMessageHandler.ts` | 147  | 122 case の巨大 switch を全解体済み（PR #102-#108）   |

**土台（導入済み）:**

- 循環依存ガード（madge/SCC ベース、`scripts/check-circular-deps.mjs`）が CI で稼働。新規サイクル 0、ベースライン 0。
- フルテスト（~3,675）が安全網。
- ローカル CI（`pnpm ci:local --strict`）が唯一の品質ゲート（GitHub Actions は課金対策で停止済み）。
- `@typescript-eslint/no-unused-vars` を再有効化（PR #109）。抽出後に露出するデッドコードを自動検出できる。

**抽出済みコラボレータ（この分割の実績・パターン例）:**

- `WebviewContentGenerator`（webview HTML 生成）
- `PendingEditOperationManager`（保留編集操作）
- `mergeCommandLists`（純関数）
- `TaskMessageStore`（会話履歴 storage＋I/O）
- `buildCleanConversationHistory`（純関数）
- decoupling: `FileContextTracker` / `WorkspaceTracker` / `SkillsManager` / `messageEnhancer` を狭い interface 依存へ。

---

## 2. なぜ incremental 抽出が止まったか（旧見立て）と、その後の実測

### 旧見立て（本 doc 初版）

残っているクラスタは**中核の可変状態とライフサイクルに orchestration が融合**しており、
1クラスをそのまま切り出すと「fat な DI interface で god-object を参照し返すだけ」になり、
負債が減らず間接化で悪化する、と整理していた。特に:

- retry / backoff / attemptApiRequest 系は `getEnvironmentDetails(this, ...)` / `buildNativeToolsArrayWithRestrictions({provider})` / `SYSTEM_PROMPT(...)` を呼ぶ
  → Task / 具象 provider の import が必要 → **循環ガードに阻まれる**

### 2026-07-26 の実測で覆った

`getEnvironmentDetails.ts` も `build-tools.ts` も、それより前の decoupling キャンペーンで既に
**narrow 化済み**（`EnvironmentDetailsHost` / `BuildToolsProvider` を受ける形。Task 非 import）だった。
つまり循環はもう障壁ではなく、新モジュール側で `getEnvironmentDetails` / `buildTools` を直接呼ばず
**deps に関数として入れる**ことで、循環増ゼロで切れる。

**実績（PR #99〜#101, #110）で切れたもの:**

| メソッド                           | 行数 | 元の判定             | 実測結果         |
| ---------------------------------- | ---- | -------------------- | ---------------- |
| `resumeTaskFromHistory`            | 237  | 循環要因あり         | **循環要因なし** |
| `addToApiConversationHistory`      | 131  | 循環要因あり         | **循環要因なし** |
| `say`                              | 113  | 循環要因あり         | **循環要因なし** |
| `attemptApiRequest`                | 395  | 循環ガードに阻まれる | **切れた**       |
| `handleContextWindowExceededError` | 131  | 同上                 | **切れた**       |
| `condenseContext`                  | 106  | 同上                 | **切れた**       |

**教訓: 候補評価はメモリではなく毎回 grep で実測すること。** 過去に判定した循環ブロッカーは
その後の decoupling で解消されている可能性がある。

### それでも残る本質的困難

- `ask` (237行) は `this.*` 22個依存で、切っても fat DI 化＝負債が減らない
- `recursivelyMakeClineRequests` (1,151行) は依然として中核ループで、`new Task()` を含む
- **本質的課題は残っている**: 共有可変状態（clineStack / 現在タスク / グローバル状態 / API ハンドラ）
  の所有権付け替えは§4 のとおり必要

---

## 3. ターゲット構成

各 god-object を **facade（VS Code 統合面・配線・公開 API のみ）＋所有権の明確なサブシステム**へ。
**境界（interface）を先に定義 → 実装を移す → 横断ニーズは DI/イベントで**、の順。

### ClineProvider →

| サブシステム             | 責務                                                  | 元メソッド                                            | 状態所有                                 |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `ClineProvider`(facade)  | webview lifecycle・VS Code 登録・配線                 | resolveWebviewView / dispose / 静的登録               | view, disposables                        |
| `WebviewStateService`    | 状態組み立て・webview への push                       | getStateToPostToWebview / getState / postState\*      | （読み取りのみ、状態は各所有者から集約） |
| `ProviderProfileService` | provider profile CRUD・有効化                         | upsert/delete/activate/get*/set*                      | providerSettingsManager 経由             |
| `TaskStackController`    | タスクスタック・委譲                                  | clineStack / add/remove/getCurrent / delegateParent\* | **clineStack を所有**                    |
| `TaskHistoryService`     | 履歴操作                                              | getTaskWithId/show/export/delete/condense             | `TaskHistoryStore`（既存）の上           |
| （済）                   | WebviewContentGenerator / PendingEditOperationManager |                                                       |                                          |

### Task →

| サブシステム             | 責務                                         | 状態所有                       |
| ------------------------ | -------------------------------------------- | ------------------------------ |
| `Task`(facade)           | ライフサイクル・公開 API                     |                                |
| `TaskMessageStore`（済） | 会話履歴 storage＋I/O                        | 2配列を所有                    |
| `ApiRequestRunner`       | attemptApiRequest・retry/backoff・rate-limit | リトライ状態                   |
| `UsageTracker`           | token/tool usage 集計・emit                  | tokenUsageSnapshot / toolUsage |
| `ContextManager`         | コンテキスト管理（一部既存 external）        |                                |

---

## 4. 課題の核心：共有状態の所有権

機械的に切れない理由 = 状態がフィールドで直接共有され、多数の場所が read/write するため。
**redesign の実作業はここ**：

1. 各サブシステムが自分の状態を private に所有する。
2. 横断アクセスは **interface / イベント** 経由にする（フィールド直接参照を禁止）。
3. `TaskMessageStore` で実証した **getter/setter プロキシ**を移行の橋渡しに使う
   （フィールドを所有者へ委譲し、既存の直接アクセスを無改修で維持 → 段階移行）。

これが「週単位・継続」の所以。境界定義そのものは低リスクだが、状態所有の付け替えは広範囲。

---

## 5. 進め方（リスク低い順）

1. **interface 先行**（純追加・挙動不変・低リスク）
   各サブシステムの公開 interface を定義。この時点では ClineProvider/Task が実装。
2. **最も低結合なサービスから**: `TaskHistoryService`（主に TaskHistoryStore＋postState）。
3. **`WebviewStateService`**（状態組み立て）— getter で状態を集約する形に。
4. **API ハンドラを interface 化** → その後 `ProviderProfileService`（updateTaskApiHandlerIfNeeded を interface 越しに）。
   ※ user-facing 経路なので**手動スモーク（プロファイル切替・モード切替）を必須**にする。
5. **`TaskStackController`** を最後に（最も中心的）。
6. Task 側: `ApiRequestRunner` → `UsageTracker`。

各ステップ独立 PR。interface 先行ステップは pure-additive でほぼ無リスク。

---

## 6. 使う技法（本セッションで実証済み）

- **getter/setter プロキシ**：共有フィールドを所有者クラスへ委譲、既存アクセス無改修（TaskMessageStore）。
- **狭い interface 依存**：コラボレータが god-object 具象でなく最小 interface を要求 → 循環を断つ（FileContextTracker）。
- **純関数モジュール**：状態非依存ロジック（mergeCommandLists / buildCleanConversationHistory）。
- **DI（deps オブジェクト）**：どうしても横断が要るサービスは依存を注入（ただし fat 化＝分離失敗のサイン、境界を疑う）。

---

## 7. 検証戦略（各ステップ必須）

- `pnpm check-types`（全パッケージ）
- フルテスト（`pnpm --filter openai-agent exec vitest run`、~3,635）
- `node scripts/check-circular-deps.mjs`（新規サイクル 0・辺数 ≤ ベースライン）
- user-facing 経路（provider-profile / mode 切替 / タスク作成・復元）は**手動スモーク**
- `Object.create(<Class>.prototype)` で constructor を迂回するテストは、getter/setter 化時に
  対象フィールドのモック追加が必要（例: ask-queued-message-drain）。

---

## 8. 完了の定義（このフェーズ）

- ClineProvider / Task がそれぞれ facade＋サブシステム構成になり、public フィールドの直接共有が
  interface/所有権に置き換わっている。
- 循環辺が有意に減少（周辺が god-object 具象でなくサブシステム interface に依存）。
- 行数は結果であって目的ではない（凝集・LCOM 改善が本質）。

---

## 9. 3本目の god: `webviewMessageHandler.ts`

ClineProvider 分割の「答え合わせ」で判明した第3の god。facade の入口自体は薄い
（`ClineProvider.setWebviewMessageListener` → `webviewMessageHandler(this, message)` の1行委譲）が、
その実体が **2,921行 / `case` 122個の巨大 switch**で、`provider.xxx` を **281回**直接参照している。

→ これが **ClineProvider が 1,544行から薄くなり切らない主因**。handler が広い public 面を要求するため、
ClineProvider の public メソッドが減らない。ClineProvider / Task に次ぐ、明示すべき第3ターゲット。

### 方針

1. **ドメインごとの sub-handler へ分割**（既存 `skillsMessageHandler` / `checkpointRestoreHandler` /
   `diagnosticsHandler` の流儀 = `export async function xxxMessageHandler(provider, message)`）。
2. **既に抽出済みのサブシステムへ委譲**する（新しい並行構造を作らない）。
    - api-config 系 → `ProviderProfileController`
    - mode/prompt 系 → `ModeController`（+ `messageEnhancer`）
    - code-index 系 → `CodeIndexStatusSubscriber`
    - task 削除/キャンセル → `Task{Deletion,Cancellation}Controller`
    - checkpoint / diagnostics → 既存 handler
      これで `provider.xxx` の直参照が「sub-handler → controller」の呼び出しへ置き換わり、
      §4 の「共有可変状態の所有権」問題と ClineProvider の public 面縮小に直結する。
3. 最終的に本体は 122-case switch をやめ、**dispatch table（`type → handler` マップ）** にする。

### グルーピング（122 case → 12 sub-handler）

| sub-handler     | 代表 case（概数）                                                        | 委譲先（既存）                       |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| worktree        | listWorktrees/create/delete/switch/checkoutBranch… (11)                  | 新規（git、core 状態から独立）       |
| codeIndex       | startIndexing/stop/status/clearIndexData… (8)                            | `CodeIndexStatusSubscriber`          |
| mcp             | toggleMcpServer/restart/delete/toolAlwaysAllow… (9)                      | 新規                                 |
| apiConfig       | save/upsert/load/delete/list/testApiConnection… (12)                     | `ProviderProfileController`          |
| mode/prompt     | mode/requestModes/customMode/getSystemPrompt… (11)                       | `ModeController` + `messageEnhancer` |
| skills+commands | createSkill/deleteCommand/openCommandFile… (10)                          | `skillsMessageHandler` 拡張          |
| settings+tts    | updateSettings/resetState/vscodeSetting/tts… (17)                        | 新規                                 |
| files/editor    | openFile/selectImages/searchFiles/openMention… (11)                      | 新規                                 |
| taskHistory     | show/delete/export/condense/costs… (7)                                   | `TaskDeletionController` ほか        |
| conversation    | deleteMessage/submitEditedMessage/…Confirm (5)                           | 新規                                 |
| taskLifecycle   | newTask/cancel/queueMessage/askResponse… (13)                            | `TaskStack/CancellationController`   |
| uiNav+diag      | switchTab/focusPanel/openDebug*/downloadErrorDiagnostics/checkpoint* (8) | 既存 diagnostics/checkpoint          |

### 進め方（リスク低い順）

1. `worktreeMessageHandler`（11 case・git 操作・core 状態から独立＝最低リスク・最初の1本）
2. `codeIndexMessageHandler` → `CodeIndexStatusSubscriber`
3. `mcpMessageHandler`（9 case）
4. `skills` に commands を統合（既存 handler 拡張）
5. `filesMessageHandler`
6. `apiConfigMessageHandler` → `ProviderProfileController`（**user-facing → 手動スモーク必須**）
7. `modeMessageHandler` → `ModeController`（同上）
8. `settings+tts`
9. `taskHistory` / `conversation`
10. `taskLifecycle`（core 可変状態と結合が最も強い＝最後）

各ステップ独立 PR。検証は §7 と同じ（型・全テスト ~3,635・循環ガード・user-facing は手動スモーク）。
本体を dispatch table にするのは全 sub-handler 抽出後の最後。

---

## 10. ClineProvider の god-constructor 解体（実装済み）

`resolveWebviewView` 抽出後の最大の塊は **173 行の constructor**で、中身はほぼ全て
collaborator の `new X({ ...deps closures })` 配線だった（17 collaborator）。Task 側
Phase 2a（`buildTaskCollaborators`）と同じ設計思想を適用して解体した。

### 構造

```
buildProviderCollaborators(host, internals) -> ProviderCollaborators
```

- **`ProviderCollaboratorHost`**: 配線が ClineProvider に要求する最小表面（`initializeWebview` /
  `taskEventForwarding` と同じ host パターン）。具象 ClineProvider を import しないので循環増ゼロ。
- **`ProviderCollaboratorHostInternals`**: `getGlobalState` / `updateGlobalState` の 2 つだけ。
  これらは `ContextProxy#getValue/setValue` の deprecated alias で **private のまま残したい**が
  配線からは呼ぶ必要がある（かつ既存 spec がこの alias に spy を張って履歴を差し込んでいる）。
  public 面を広げないため host interface ではなく明示引数にした。
- **`ClineProviderOptions`**（第 5 引数）: `{ taskFactory?, collaborators? }`。positional 引数を
  増やさずに Task 側 `TaskOptions.collaborators` と同じ注入口を開けた。既存の 4 引数呼び出しは無変更。
- constructor は「代入 + MCP hub の非同期受け取り」だけの 46 行になった。

### 併せて切り出した「host が private に持っていた責務」

配線を factory へ出すには private メンバ依存を解く必要があり、それが素直に責務分離になった:

| 新モジュール                        | 移した責務                                            | 消えた ClineProvider のメンバ                                 |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `updateTaskApiHandler.ts`           | provider/model 差分での API ハンドラ再構築判定        | `updateTaskApiHandlerIfNeeded()` (28 行)                      |
| `RecentTasksCache.ts`               | 最近タスク id の memoize と無効化                     | `recentTasksCache` field + `getRecentTasks` の分岐            |
| `GlobalStateHistoryWriteThrough.ts` | globalState への write-through デバウンス（タイマー） | `globalStateWriteThroughTimer` field + schedule/flush (35 行) |

### createTask / createTaskWithHistoryItem の分解

| 新モジュール                      | 移した責務                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `applyCreateTaskConfiguration.ts` | `AgentSettings` を global state / VS Code 設定 / profile / custom modes へ反映（40 行） |
| `replayPendingEdit.ts`            | チェックポイント復元をまたいだメッセージ編集の再生（42 行）                             |

### テスト

- `buildProviderCollaborators.spec.ts`: 組み立て内容・遅延参照（構築後の
  `providerSettingsManager` / `customModesManager` 差し替えに追従）・onWrite → write-through・
  fire-and-forget 初期化の失敗ハンドリング。
- `ClineProvider.collaborator-injection.spec.ts`: **`vi.mock` を 1 つも書かずに real ClineProvider を
  構築する** spec。collaborator を注入すると ProviderSettingsManager / CustomModesManager /
  SkillsManager / McpServerManager / WorkspaceTracker / TaskHistoryStore が一切実体化しないことの実証。
  fake の入口は `__tests__/makeFakeProviderCollaborators.ts`（Task 側 `makeFakeCollaborators` の対応物）。
- 各切り出しモジュールにも unit spec を追加。

---

## 11. 「state machine 化」を試して見送った記録（`connectToServer`）

`McpHub.connectToServer`（126 行）は 2 巡の抽出後もファイル最大のメソッドとして残った。
「抽出ではなく設計の一手が要る」と判断して **state machine 化を検討し、実測の結果見送った**。
見送りの判断そのものが再利用できるので、手順ごと残す。

### 手順 1: フェーズ表を書く（何を読み・何を変え・失敗したらどうなるか）

| #     | フェーズ                                | 変えるもの                  | try 内? | 失敗時               |
| ----- | --------------------------------------- | --------------------------- | ------- | -------------------- |
| 1     | 既存接続の削除                          | store / watcher / transport | ×       | 内部で握り潰し       |
| 2     | サニタイズ名の登録                      | store                       | ×       | —                    |
| 3     | MCP 全体の有効判定                      | —                           | ×       | **伝播（記録なし）** |
| 4     | サーバ個別の無効判定                    | —                           | ×       | —                    |
| 5     | ファイル監視の設定                      | watcher map                 | ×       | **伝播（記録なし）** |
| 6-8   | client 構築 / 変数展開 / transport 生成 | 外部プロセス・ソケット      | ○       | 記録先が**まだ無い** |
| 9     | store へレコード追加                    | **store**                   | ○       | —                    |
| 10-11 | connect / capabilities 取得             | レコードを in-place 更新    | ○       | 記録される           |

### 手順 2: 不変条件を先に言語化する

- **I1/I2（採否の分かれ目）**: `catch` は `find(name, source)` でレコードを探してエラーを記録するが、
  **フェーズ 9 を通過したかどうかで挙動が変わる**。8 以前で落ちるとレコードが存在せず何も記録されない
  （フェーズ 1 が既存を消しているため）。つまり try の範囲＝「記録先が存在する区間」であり、
  **フェーズを細切れの関数に割ると、この条件が暗黙のうちに壊れる。**
- **I3**: transport ハンドラは接続オブジェクトを閉じ込めず、発火時に名前で引き直す
  （transport は再接続をまたいで生き残るため、閉じ込めると捨てられたレコードを更新する幽霊更新になる）。
- **I4**: フェーズ 3/5 は try の外。失敗しても記録せず伝播する（呼び出し側がログする）。

### 手順 3: driver の context に何が要るかを数える（fat DI 判定）

フェーズ 6〜11 を関数に割って driver で回すには、context に以下が要る:

`providerRef` / `connectionStore` / `notifyWebviewOfServerChanges` / `fetchToolsList` /
`fetchResourcesList` / `fetchResourceTemplatesList` / `settingsPaths` — **7 メンバ（うち private
メソッド 3）＝ 実質 `this`**。§6 のとおり fat DI は分離の失敗サインなので、ここで**打ち切り**。

### 結論: これは state machine ではない

分岐はフェーズ 3/4 の **3 分岐ゲートだけ**で、6〜11 は分岐もループも再入もない直列手続き。
状態と遷移が無いものに state enum と dispatch を被せても、**分岐ゼロの dispatch 層が増えるだけ**。
「大きいメソッド＝ state machine にすべき」ではなく、**まず分岐を数える**こと。

- 分岐が多く再入がある → state machine が効く
- 分岐が入口だけの直列手続き → **入口の判定を純関数に、直列部分はそのまま残す**

### 実際に効いた切り方（`connectServer.ts`）

state machine の代わりに、フェーズ表が炙り出した「狭い依存で切れる塊」だけを出した:

| 切り出したもの                                              | 種類                                          | 依存の数                   |
| ----------------------------------------------------------- | --------------------------------------------- | -------------------------- |
| `resolveConnectPlan`                                        | 純関数（3 分岐ゲート）                        | 引数 2（スカラ）           |
| `createPlaceholderConnection` / `createConnectedConnection` | 純関数（レコード生成）                        | データのみ                 |
| `makeConnectionTransportHandlers`                           | narrow deps                                   | `find` と `notify` の 2 つ |
| `recordConnectionFailure`                                   | narrow deps（I1/I2 を関数の契約として明文化） | `find` の 1 つ             |

126 → 76 行。直列の背骨は McpHub に残したまま、**判定とレコード生成とハンドラ方針が単体テスト可能**になった
（`connectServer.spec.ts` で 21 件。I3 は「ハンドラ生成後に store が別レコードへ差し替わっても
新しい方が更新される」テストで固定した）。

### 手法としての位置づけ

§6 の 3 パターン（getter/setter プロキシ / 狭い interface / 純関数＋小クラス）に対する 4 つ目は
**「state machine」ではなく「フェーズ表 → 不変条件 → driver context の member 数え」という
_判定手順_** だった。大きいメソッドを前にしたら、まずこの 3 手を踏んで**割るか割らないかを決める**。

---

## 付録: 関連

- 循環ガード運用: `scripts/check-circular-deps.mjs`（`--update` でベースライン締め直し）
- 既知の別 issue: tree-sitter runtime の削除言語マッピング（#32）
