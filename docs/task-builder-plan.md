# TaskBuilder 設計 — constructor 47 依存の分解計画

> [!NOTE] > **これは計画時点の記録で、現状ではない。** 「残置」と書かれた `getTaskMode()` /
> `setTaskApiConfigName()` / `_taskMode` proxy は移行完了により既に存在しない
> （webview は `task.modeState.mode = mode` を直接使う）。現状は
> `docs/ARCHITECTURE.md` を参照。

## 現状の問題

`Task` class の constructor は 154 行、47 の option field を受け取り、11 collaborator を
その場で `new` する god-constructor。

**症状:**

- テストで real Task を作るとき 8–34 `vi.mock` を並べる必要
- 5 test files が `vi.mock("../../task/Task", ...)` で **Task 自体を丸ごと fake** に置き換え
- `ClineProvider.spec.ts` の fake は Task の 14 メンバしか露出しない
  → 実際に ClineProvider が要求する Task 表面は 14 個だけ、それ以外は死んでいる
- `Object.create(Task.prototype)` bypass テストが `ask-queued-message-drain.spec.ts` に 2 件残る
  （constructor が高価だから prototype 直接構築）

## 目標

- **Task の構築ロジックと Task 自体の責務を分離**する
- テストで collaborator を注入できるようにする（fake DiffViewProvider / fake TokenUsageTracker 等）
- Task class 本体は「collaborator を受け取って動く」だけの薄い object になる
- 既存の 4 collaborator（AskState / GraceRetryCounter / MistakeTracker / StreamingSession）と
  同じ設計思想を constructor 側にも適用する

## Phase 1 — collaborator の遅延初期化（既に済み）

- ✅ AskState / GraceRetryCounter / MistakeTracker / StreamingSession は
  `readonly foo = new Foo()` の class field で初期化 → constructor の外で完結
- ✅ makeMockTask factory が用意されているので test 側もこれらを実インスタンスで作れる

## Phase 2 — 「実 collaborator の new」を Task 外へ

現在 constructor 内で `new` している 8 collaborator を **factory function 経由**にする:

- `AgentIgnoreController` (line 342)
- `AgentProtectedController` (line 343)
- `FileContextTracker` (line 344)
- `AutoApprovalHandler` (line 352)
- `TaskMessageStore` (line 357)
- `DiffViewProvider` (line 358)
- `MessageQueueService` (line 366)
- `TokenUsageTracker` (line 385)
- `ApiRequestTimingController` (line 387)
- `ToolRepetitionDetector` (line 377)
- `MultiSearchReplaceDiffStrategy` (line 375)

### 提案する構造

```typescript
// 新モジュール src/core/task/TaskBuilder.ts
export interface TaskCollaborators {
  rooIgnoreController: AgentIgnoreController
  rooProtectedController: AgentProtectedController
  fileContextTracker: FileContextTracker
  messageStore: TaskMessageStore
  diffViewProvider: DiffViewProvider
  diffStrategy: DiffStrategy
  messageQueueService: MessageQueueService
  autoApprovalHandler: AutoApprovalHandler
  toolRepetitionDetector: ToolRepetitionDetector
  api: ApiHandler
  // ... plus config values
}

export function buildTaskCollaborators(options: TaskOptions): TaskCollaborators {
  // すべての `new Foo(...)` をここに移動
  return { ... }
}
```

Task の constructor は:

```typescript
constructor(options: TaskOptions | { collaborators: TaskCollaborators; ...restOptions }) {
  const collaborators = "collaborators" in options ? options.collaborators : buildTaskCollaborators(options)
  this.rooIgnoreController = collaborators.rooIgnoreController
  // ... assign all fields from collaborators
}
```

**テストは:**

```typescript
const task = new Task({
	collaborators: {
		rooIgnoreController: fakeIgnore, // inject fake
		diffViewProvider: fakeDiff,
		// ...
	},
	...restOptions,
})
```

もう `vi.mock("../../../ignore/AgentIgnoreController")` は不要。

### Phase 2b の実装（済み）

union overload ではなく `TaskOptions` の optional field にした（`collaborators?: TaskCollaborators`）。
分岐は constructor 1 行:

```typescript
const collaborators = injectedCollaborators ?? buildTaskCollaborators({ ... })
```

union にすると呼び出し側 500+ 箇所の型推論に影響するのに対し、optional field なら既存
呼び出しは無変更で通る。テスト側の入口は `src/core/task/__tests__/makeFakeCollaborators.ts`
（`makeMockTask` が「Task ごと fake」なのに対し、こちらは「real Task + fake collaborator」）。

実証: `Task.sticky-profile-race.spec.ts` の `vi.mock("../../ignore/AgentIgnoreController")` を
`collaborators: makeFakeCollaborators()` に置換して削除できた。

### Phase 2c の実装（済み・3 spec）

`Task.persistence` / `flushPendingToolResultsToHistory` / `grace-retry-errors` の 3 spec
（計 28 `new Task({})` call sites）を注入経路へ migrate、`vi.mock("../../ignore/AgentIgnoreController")`
を 3 本削除（Phase 2b の 1 本と合わせて計 4 本）。

**途中で判明した設計上のコツ**: `makeFakeCollaborators` の `messageStore` を最初は
`vi.fn()` の fake で埋めていたが、persistence spec は `vi.mock("../../task-persistence")`
経由の `mockSaveApiMessages` に retry ロジックが到達することを検証しているため fake だと即
返り値してしまい 6 test が fail した。**`TaskMessageStore` は vscode 非依存**なので実
インスタンス（`new TaskMessageStore(taskId, path)`）を default にすることで解消。内部で
呼ぶ `saveApiMessages` は module mock がそのまま効くのでテスト側 setup は無変更。

`Task.spec.ts`（40+ call sites）は blast 半径が大きいので Phase 2c-2 で別 PR に分割
検討したが、実装中に **中止判定**（次項）。

### Phase 2c-2 の中止判定

`Task.spec.ts` の 41 site を機械的に注入経路へ移すと 8 test が fail する。原因は
「constructor 挙動そのもの」を検証している test 群が **fake 注入と目的が正面衝突**する
ため:

- `consecutiveMistakeLimit: 5` オプション → `task.mistakeTracker.limit === 5` を検証する
  test は、fake `MistakeTracker(3)` を注入されると壊れる（オプションが factory を通らず反映
  されない）
- `task.diffStrategy instanceof MultiSearchReplaceDiffStrategy` を検証する test は、fake の
  duck-typed diffStrategy では通らない
- API protocol などの constructor 派生値も同様

これは Phase 2b/2c の pattern を **どの spec に適用すべきでないか** の学び:

- 「real Task を構築して**メソッド挙動を検証**する spec」（persistence/flush/grace-retry） → 適用○
- 「constructor が options から何を組み立てるかを検証する spec」（Task.spec.ts の一部） → 適用×

Task.spec.ts はこの 2 種類が混在しているため、機械的一括変換ではなく **test 単位での判別**が
必要になり ROI が悪い。既存の `vi.mock("../../ignore/AgentIgnoreController")` を維持する
方が読み手にも意図が明確。

## Phase 3 — ClineProvider に taskFactory を注入（実装済み）

`ClineProvider` の 6 spec が `vi.mock("../../task/Task", ...)` で Task を module-level
fake に差し替え、`vi.mocked(Task).mockImplementation(...)` で action-at-a-distance に
制御していた。これを **DI seam** に置き換え。

**構造:**

```ts
// ClineProvider.ts
export type TaskFactory = (options: TaskOptions) => Task
constructor(
  ...,
  taskFactory?: TaskFactory,
) {
  this.taskFactory = taskFactory ?? ((opts) => new Task(opts))
}
// 内部 2 箇所の `new Task(opts)` を `this.taskFactory(opts)` に
```

**spec 側:**

```ts
const fakeTaskFactory = (options: any) => ({ taskId: ..., abortTask: vi.fn(), ... })
provider = new ClineProvider(..., fakeTaskFactory)
```

**vi.mock は「Task.ts の transitive vscode load を防ぐ stub」として残す**（4 spec で保持、
1 spec は vscode mock が完全なので撤去）。中身は `throw new Error(...)` の 3 行で、fake
surface は spec の `fakeTaskFactory` に集約。ClineProvider が fakeTaskFactory を使う限り
real Task は決して構築されない。

**移行済み 5 spec:** `ClineProvider.spec.ts` (3150 行, 6 ClineProvider / 27 Task site) /
`ClineProvider.sticky-mode.spec.ts` (1216 行, 8 site) / `ClineProvider.taskHistory.spec.ts` (732
行) / `ClineProvider.lockApiConfig.spec.ts` (335 行) / `ClineProvider.flicker-free-cancel.spec.ts`
(294 行, vi.mock 完全撤去)。もう 1 file (`presentAssistantMessage-unknown-tool.spec.ts`) は
別 PR #238 で dead-code 削除済み。

## Phase 2d — Task.create() の削除（実装済み）

Phase 3 完遂後に実態調査したところ、`Task.create()` は **production コードから 0 呼び出し**、
呼び出し元は `Task.spec.ts` の 6 site のみ（100% test-only）と判明。

当初 doc の「factory-first に書き換え」は Phase 3 完遂前の想定で書いたもので、実際は
production 挙動に効果 0 の cosmetic 変更にしかならなかった。

**採った代替方針: 削除**。6 test を `new Task({...startTask: false}) + cline.start()` に
機械的置換して Task.ts から `Task.create` (14 行) を撤去。既存の `public start(): void` は
`public start(): Promise<void>` へ変更（既存の fire-and-forget 呼び出しは Promise を無視
するだけで挙動不変、test は `await cline.start()` で同期取れる）。効果:

- Task.ts の未使用 static entry が消える（-14 行）
- production 側の Task 構築の唯一の path が `new Task(...)` に統一される（ClineProvider の
  `taskFactory` が既定 `(opts) => new Task(opts)` を呼ぶ、Phase 3 の DI seam のみ）
- test 側は「start promise を await したい」意図が `cline.start()` の explicit 呼び出しで
  表面化する（Task.create の tuple return 越しより読みやすい）
- `Task.start()` が Promise を返すことで将来 await 可能な path が生まれた

## Phase 4 — 責務分割 (段階的)

Constructor が抱えていた logic を、**単体テスト可能な collaborator へ所有権ごと移す**。
「Task.ts の行数を減らす」ではなく「その判断を Task 以外がテストできるか」で切る。

### Phase 4a — argument validation（実装済み）

`validateTaskOptions.ts`（純関数）。`checkpointTimeout` の範囲と
`task/images/historyItem` の排他だけを担う。

### Phase 4b — 購読の登録/解除を TaskSubscriptions が所有（実装済み）

**症状**: 購読の寿命が 2 ファイルに割れていた。登録は constructor、解除は `disposeTask`、
その 2 箇所を `Task.messageQueueStateChangedHandler` /
`Task.providerProfileChangeListener` という **mutable public field** で繋いでいた
（= 内部の実装詳細が Task の public 表面に漏れ、`disposeTask` の host interface にも
出ていた）。

**構造**:

- `TaskSubscriptions`（registry）: `add(TaskSubscription | undefined)` / `disposeAll()`。
  個々の teardown を try/catch で包んで 1 件失敗しても残りを畳む。dispose 後の `add` は
  即 teardown（遅れて張られた購読のリーク防止）。
- `subscribeMessageQueueStateChanged`（旧 `makeMessageQueueStateChangedHandler`）:
  `on` と `removeListener` を**一組で**返す。
- `subscribeProviderProfileChange`（旧 `setupProviderProfileChangeListener`）: 同上。
  provider は **WeakRef 越しにしか触らない**（teardown closure が provider を強参照すると
  Task が生きている間 ClineProvider が GC されない）。

結果: Task から mutable public field 2 個が消え、`disposeTask` の host から
`providerProfileChangeListener` / `messageQueueStateChangedHandler` / `providerRef` の
3 メンバが消えた。constructor 側は `subscriptions.add(...)` 2 行。

**逐語でない点**: dispose 順が「provider off → queue removeListener」から
「queue removeListener → provider off」へ（互いに独立、影響なし）。失敗時のログ文言が
`Error disposing task subscription (<label>):` に統一された。

### Phase 4c — mode/apiConfig 状態と起動 dispatch（実装済み）

**TaskModeState**: `_taskMode` / `_taskApiConfigName` / 2 本の readiness promise と、
constructor の `historyItem ? 即値 : async 初期化` 分岐、さらに
`initializeTaskModeAndApiConfig.ts`（host の field を外から書き換える 2 関数）を 1 クラスへ統合。
`fromHistoryItem()` / `fromProvider()` の 2 factory で「どちらの初期化経路か」が型に出る。
vscode 非依存なので provider fake だけで race（profile 切替が初期化を追い越すケース）を直接テストできる。
Task 側は `_taskMode` / `_taskApiConfigName` / `taskApiConfigReady` を **getter/setter プロキシ**
として残す（ClineProvider の sticky-mode 更新と `saveClineMessages` の直接アクセスを無改修で通すため）。

**TaskLauncher**: 起動元（`fresh` / `history` / `none`）を構築時に 1 度だけ確定させ、
起動済みフラグもここが持つ。constructor の 3 分岐と `Task.start()` の
metadata ベース分岐という**重複した 2 実装**が 1 箇所に収束した。

**逐語でない点 / 潜在バグの解消**:

- constructor 末尾の `else { throw new Error("Either historyItem or task/images...") }` は
  `validateTaskOptions` が先に同じ条件で throw するため **到達不能な dead branch** だった → 削除。
- 旧 `Task.start()` は `metadata` から起動元を判定していたが、history 再開時の metadata は
  `{ task: historyItem.task, images: [] }` になるため、`historyItem` + `startTask: false` で
  作った task を `start()` すると **履歴本文を新規 task として startTask に渡す**誤経路だった
  （production では `createTaskWithHistoryItem` が `startTask` を既定 true で作るためこの組み合わせは
  発生せず、顕在化していない）。`TaskLaunchSource` で起動元を明示したため resume 経路に落ちる。

### Phase 4d — identity 解決の純関数化（実装済み）

`resolveTaskIdentity`: `taskId` / `rootTaskId` / `parentTaskId` / `metadata` / `workspacePath` /
`instanceId` を決める「historyItem があればそちらが勝つ」規則（constructor 内に散っていた
5 つの三項演算子）を 1 つの純関数へ。副作用（id 生成・既定 workspace 解決）は deps で注入するので
モジュール自体は vscode / uuid に依存せず、規則そのものをテストできる。
ついでに `this.taskNumber = -1` → `this.taskNumber = taskNumber` の**二重代入（前者は dead）**を削除。

## 想定ステップと難度

| Phase | scope                                                                | 難度 | ROI                                                         |
| ----- | -------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| 2a    | ✅ `buildTaskCollaborators` factory 追加、内部で全 `new` を実行      | 中   | 高（テスト注入可能に）                                      |
| 2b    | ✅ `TaskOptions.collaborators` 注入口 + `makeFakeCollaborators`      | 小   | 高（vi.mock なしで real Task が作れる）                     |
| 2c    | ✅ real-Task spec 3 本を注入経路へ（persistence/flush/grace-retry）  | 中   | 中（`vi.mock` 4 本削除・pattern 定着）                      |
| 2c-2  | ❌ 中止: `Task.spec.ts` は constructor 挙動テスト、注入と目的が競合  | —    | —                                                           |
| 2d    | ✅ `Task.create()` を削除（production 0 呼び出し、test 6 site 書換） | 小   | 小（dead-ish entry 撤去）                                   |
| 3     | ✅ `ClineProvider.taskFactory` 注入で `Task.mockImplementation` 撤去 | 大   | 大（action-at-a-distance の module mock を DI seam へ移行） |
| 4a    | ✅ Argument validation を `validateTaskOptions` へ                   | 小   | 中                                                          |
| 4b    | ✅ 購読の登録/解除を `TaskSubscriptions` + `subscribe*` が所有       | 中   | 中（public field 2 個撤去・dispose 側 host が縮む）         |
| 4c    | ✅ `TaskModeState` / `TaskLauncher`（起動 dispatch の重複を解消）    | 中   | 高（dead branch と start() の誤経路を解消）                 |
| 4d    | ✅ `resolveTaskIdentity`（historyItem 優先規則の純関数化）           | 小   | 中                                                          |
| 5a    | ✅ Step 2: `TaskModeState` の proxy 撤去（dead API 5 個も同時削除）  | 小   | 高（Task から 7 メンバ撤去、edit は 10 行程度）             |
| 5b    | ✅ Step 2: `TokenUsageTracker` の proxy / 委譲 5 個を撤去            | 中   | 中（Task から 5 メンバ撤去、140 site を機械置換）           |
| 5c    | ✅ Step 2: `TaskMessageStore` の proxy 4 アクセサを撤去              | 大   | 中（250 site / 47 files を機械置換、Task の配列表面が消滅） |

## Phase 5 — collaborator proxy の Step 2（proxy 撤去）

「Step 1: 別 class に state を移して Task 側に proxy を残す → Step 2: 全 caller を
`task.<collaborator>.foo` 直参照にして proxy を撤去する」の後半。

### 5a — TaskModeState（実装済み）

実測で判明したのは proxy そのものより **facade API がほぼ死んでいた**こと:

| Task のメンバ                      | 実測 caller            | 処置                                 |
| ---------------------------------- | ---------------------- | ------------------------------------ |
| `get taskMode()`                   | **0**（test すらなし） | 削除                                 |
| `waitForModeInitialization()`      | **0**                  | 削除                                 |
| `getTaskApiConfigName()`           | **0**                  | 削除                                 |
| `get taskApiConfigName()`          | test 1                 | 削除（test は `modeState` 直参照へ） |
| `waitForApiConfigInitialization()` | test 1                 | 削除（同上）                         |
| `get/set _taskApiConfigName`       | `saveClineMessages` 1  | 削除（host が `modeState` を受ける） |
| `get taskApiConfigReady`           | `saveClineMessages` 1  | 削除（同上）                         |
| `getTaskMode()`                    | webview 1              | **残置**（webview 移行待ち）         |
| `setTaskApiConfigName()`           | webview 1              | **残置**（同上）                     |
| `get/set _taskMode`                | webview 1（cast 越し） | **残置**（下記の理由で危険）         |

`_taskMode` だけは webview 側が `(task as unknown as { _taskMode: Mode })._taskMode = mode`
という **cast** で書いているため、Task から消しても型エラーが出ず runtime だけ壊れる。
webview を `task.modeState.mode = mode` に直すまで proxy を残し、`@deprecated` で明示する。

### 5b — TokenUsageTracker（実装済み）

`toolUsage` proxy / `getTokenUsage()` / `emitFinalTokenUsageUpdate()` /
`recordToolUsage()` / `recordToolError()` の 5 メンバを撤去し、caller を
`task.tokenUsageTracker.*` へ。`get tokenUsage()` だけは `TaskLike`(@openai-agent/types)
が要求するため残す。

host interface 側は `mistakeTracker: { count: number }` と同じ **inline 構造型**で宣言し、
`core/tools` → `core/task` の import 辺を増やさない（循環ガード維持）。

**発見**: `__tests__/nested-delegation-resume.spec.ts` の fake は `as unknown as Task`
で cast していたため、削除したメンバ（`emitFinalTokenUsageUpdate` / `toolUsage`）を
持ったまま型チェックを通過し、**実行時にだけ**落ちた。cast fake は Step 2 の安全網に
ならないので、移行時は必ずフルテストを回すこと。

### 5c — TaskMessageStore（実装済み。当初は保留、理由も残す）

`clineMessages` / `apiConversationHistory` proxy の撤去は**実行可能だが今は待つ**判断。

実測（Task を receiver とする参照のみ、`GlobalFileNames.*` 等は除外）:

| 領域                                 | production | test | 備考                               |
| ------------------------------------ | ---------- | ---- | ---------------------------------- |
| `core/webview`                       | **30**     | ~72  | `taskMessageHandlers.ts` だけで 22 |
| `core/task`                          | ~30        | ~48  |                                    |
| `core/message-manager`               | 7          | 51   |                                    |
| `core/checkpoints/tools/environment` | 6          | 5    |                                    |
| **計**                               | ~73        | ~176 | **約 250 site / 45 files**         |

保留理由:

1. 250 site のうち **約 100 が `core/webview` 配下**。`taskMessageHandlers.ts` /
   `ClineProvider.spec.ts` は並行して別作業が入っており、手作業マージの衝突コストが高い。
2. proxy を残したまま core/task 側だけ `host.messageStore.clineMessages` に変えても
   **Task の public 表面は 1 メンバも減らない**（＝純粋な churn）。atomic にやる必要がある。
3. 5a/5b と違い、こちらは「消せる dead API」が無く、純粋に 250 行の機械置換。

**着手条件**: webview 配下の並行作業が止まったタイミングで、1 PR にまとめて
`sed 's/\.clineMessages/.messageStore.clineMessages/g'` 相当を全域に当てる
（5b と同じ手順。fake が cast 越しに古い形を保持し得るので必ずフルテストで確認）。

#### 実施結果（着手条件が解けた回）

上記のとおり atomic に実行し、**Task から `get/set apiConversationHistory` と
`get/set clineMessages` の 4 アクセサを撤去**。47 file 変更（`core/task` 25 /
`core/webview` 14 / その他 8）。

手順（再現用）:

1. **call site**: `TaskMessageStore.ts` を除く全 `.ts` に
   `sed -e 's/\.clineMessages\b/.messageStore.clineMessages/g' -e 's/\.apiConversationHistory\b/.messageStore.apiConversationHistory/g'`。
   `\b` があるので `clineMessagesSeq` は巻き込まれない。
2. **revert**: Task 以外の receiver を戻す。`GlobalFileNames.apiConversationHistory`（ファイル名定数）/
   `extras.clineMessages`（ExtensionState 組み立て）/ `result.apiConversationHistory`
   （`getTaskWithId()` の戻り値）/ `deps.clineMessages`（`upsertAskMessage` は配列を値渡しで
   受ける deps なので Task view ではない）/ `messageStore.messageStore.` の二重化。
3. **host 宣言**: 24 個の narrow host interface の `clineMessages: ClineMessage[]` を
   `messageStore: { clineMessages: ClineMessage[] }` に。`mistakeTracker: { count: number }` と
   同じ **inline 構造型**で宣言し、`core/tools` → `core/task` などの import 辺を増やさない。
4. **proxy 撤去** → ここまでで tsc が通る。
5. **cast fake の修正**（tsc では見えない）。

**移さなかったもの**（Task view ではないため）:

- `UpsertAskMessageDeps.clineMessages` — 配列そのものを渡す deps。呼び出し側
  (`runAskFlow`) が `host.messageStore.clineMessages` を渡す形に変わっただけ。
- `ExtensionState["clineMessages"]` / `getTaskWithId()` の戻り値 / `exportTask` の引数 /
  `TaskHistoryReader` のローカル — いずれも Task ではなく「メッセージ配列そのもの」。
- `shared/todo.ts` `getLatestTodo(clineMessages)` — 純関数の引数名。

**教訓の再確認**: 型チェックが通った時点で **92 test が fail** した。全て
`as unknown as Task` / `as any` の fake が古い平坦な形のままだったため（`mockTask` /
`mockCline` / `getCurrentTaskMock` / `mockCurrentTask` の 11 リテラル）。5b で書いた
「cast fake は Step 2 の安全網にならない」がそのまま再現したので、**tsc 緑＝完了ではない**。
一方で紛らわしい同名リテラル（`uiMessagesFilePath` と並ぶ `apiConversationHistory` =
`getTaskWithId()` の戻り値、`version` と並ぶ `clineMessages` = `ExtensionState`）は
**変換してはいけない**ので、機械変換時は前後行の文脈で除外リストを作ること。

### 却下: collaborator を 1 field にまとめる案

constructor の `this.xxx = collaborators.xxx` 11 連続を
`this.collaborators = collaborators` 1 行にして参照側を `this.collaborators.xxx` に
する案は **却下**。実測した参照数は以下で、11 行の宣言を削る代わりに約 460 箇所へ
間接参照を 1 段増やすだけで、**所有権は何も変わらない**（Task が collaborators を
持つことに変わりはない）。

| field                    | 参照数 |     | field                    | 参照数 |
| ------------------------ | ------ | --- | ------------------------ | ------ |
| `mistakeTracker`         | 217    |     | `messageQueueService`    | 37     |
| `api`                    | 54     |     | `apiConfiguration`       | 35     |
| `rooIgnoreController`    | 40     |     | `fileContextTracker`     | 28     |
| `diffStrategy`           | 17     |     | `messageStore`           | 14     |
| `rooProtectedController` | 11     |     | `toolRepetitionDetector` | 4      |
| `autoApprovalHandler`    | 2      |     |                          |        |

11 行の代入は「宣言」であってロジックではない。Task の表面を実際に縮めるレバーは
proxy 撤去（5a–5c）の側なので、そちらに寄せる。

## 現時点で書いていない理由

- 全部やると 500+ files の変更 blast、1 セッションで抱えるには重い
- Phase 2a 単体でも review scope として大きい（factory + Task constructor 書き換え + 12 test file の migration）
- **本 doc は "設計 doc 先行" の宣言**。実装 PR は本 doc を reference しつつ段階的に。

## 依存関係

- ✅ AskState (PR #222/#223)
- ✅ GraceRetryCounter (PR #224)
- ✅ MistakeTracker (PR #225/#226)
- ✅ StreamingSession (PR #228/#229)
- ✅ TaskTestFactory (PR #230) ← Phase 2 の migration で活用できる基盤
- ⏳ Phase 2a 開始条件: 上記全部 merge 済み（達成）

次の PR で Phase 2a に着手可能。
