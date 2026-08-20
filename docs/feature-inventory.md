# 機能 / 設定 一覧（棚卸し）

このフォークを整理するための全機能・全設定のインベントリ。Roo Code から継いだ機能も含む全量を、
一次ソース（`packages/types` のスキーマ、`src/package.json` の contributes、`TOOL_GROUPS`、
`DEFAULT_MODES`、`experiment.ts`、SkillsManager、built-in commands）から起こしている。

このフォークの実態:

- **出荷プロバイダは OpenAI 互換1本**（`src/core/task/runRecursiveClineLoop.ts` などで `apiProtocol="openai"` 固定）。
- 狙いは「Azure / OpenAI 互換 GPT-5.x ＋社内 proxy でのコーディングエージェント」。

`位置づけ` は整理のための初期見立てであり、**削除は個別検証が前提**（挙動確認せず消さない）。
凡例: **核**=用途の中心 / **補助**=あると便利 / **要精査**=未使用か upstream 由来で用途に合わない疑い / **済**=削除済み。

> **削除済み（2026-08 整理）**: TTS / 効果音（PR #422）、zsh/powershell 固有ターミナル設定4つ・死んだ provider i18n placeholder（PR #421）。詳細は各節の **済** 参照。

---

## A. エージェント能力

### A1. ツール（`toolNames` 全24、実送信は非エイリアスのみ）

グループ（`src/shared/tools.ts` の `TOOL_GROUPS`）:

| グループ | tools                                                                                 | customTools（opt-in）                        |
| -------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| read     | read_file, search_files, list_files, codebase_search, web_fetch（0.8.2 で opt-in）    | —                                            |
| edit     | apply_diff, write_to_file                                                             | edit, search_replace, edit_file, apply_patch |
| command  | execute_command, read_command_output                                                  | —                                            |
| mcp      | use_mcp_tool, access_mcp_resource                                                     | —                                            |
| modes    | switch_mode, new_task                                                                 | —                                            |
| 常時     | ask_followup_question, attempt_completion, update_todo_list, run_slash_command, skill | —                                            |

- エイリアス: `search_and_replace`→edit / `search_replace` / `edit_file`→apply_diff。**要精査**（同機能の別名が複数）。
- `custom_tool`: MCP 動的ツールの受け皿。
- `codebase_search`: コードインデックスが有効なときのみ提示（既定は無効で自動除外）。**要精査**（埋め込みインデックスを使うか）。

### A2. モード（`DEFAULT_MODES` 全5）

architect / **code（既定）** / ask / debug / orchestrator

- **要精査**: debug・orchestrator・architect を実運用しているか。使わないならモード選択の雑音。

### A3. スキル（`skill` ツール / `src/services/skills/SkillsManager.ts`）

- 仕組みのみで**組み込みスキルは無し**。`.agent/skills/[name]/`（project）と global から Markdown を発見。
  mode 別 `skills-[mode]` と symlink に対応。
- **要精査**: スキルを1つでも定義して使っているか。未使用なら機構ごと重い。

### A4. スラッシュコマンド（`run_slash_command` ツール / experiment `runSlashCommand` でゲート）

- **built-in は `/init` の1つのみ**（`src/services/command/built-in-commands.ts`）。
- workspace: `.agent/commands/*.md` → 現状 **commit.md, release.md** の2つ。global も探索。
- 既定では experiment OFF＝送られない。**要精査**: experiment を常用しているか。

### A5. MCP（`use_mcp_tool` / `access_mcp_resource` / `McpHub`）

- `mcpEnabled` 設定でトグル。サーバ / リソース / alwaysAllow / disabledTools を持つフル実装。
- **要精査**: MCP サーバを実際に繋いでいるか。未使用なら大きな面積。

### A6. experiments（`packages/types/src/experiment.ts`、実フラグ2つ）

- `preventFocusDisruption`（背景編集） / `runSlashCommand`。

---

## B. 設定

### B1. プロバイダ設定（`packages/types/src/provider-settings.ts`、21キー）

- **核**: openAiApiKey, openAiBaseUrl, openAiModelId, openAiUseAzure, azureApiVersion,
  openAiUseResponsesApi, openAiStreamingEnabled, openAiHeaders, enableReasoningEffort, modelTemperature。
- **補助**: includeMaxTokens, rateLimitSeconds, consecutiveMistakeLimit, todoListEnabled, webFetchEnabled。
- **要精査**: apiProvider / apiModelId / modelId（単一プロバイダで形骸化していないか）、fakeAi（テスト用）。

### B2. グローバル設定（`packages/types/src/global-settings.ts`、約75キー）

- **自動承認（~16）**: autoApprovalEnabled, alwaysAllow{ReadOnly, ReadOnlyOutsideWorkspace, Write,
  WriteOutsideWorkspace, WriteProtected, Execute, Mcp, ModeSwitch, Subtasks, FollowupQuestions},
  allowedCommands, deniedCommands, allowedMaxCost, allowedMaxRequests, followupAutoApproveTimeoutMs, requestDelaySeconds
- **コンテキスト / 要約（~12）**: autoCondenseContext, autoCondenseContextPercent, customCondensingPrompt,
  maxOpenTabsContext, maxWorkspaceFiles, maxGitStatusFiles, includeCurrentCost, includeCurrentTime,
  includeDiagnosticMessages, maxDiagnosticMessages, diagnosticsEnabled, includeTaskHistoryInEnhance
- **ターミナル（~8）**: terminalCommandDelay, terminalOutputPreviewSize, terminalShellIntegrationDisabled,
  terminalShellIntegrationTimeout, terminalZdotdir, execaShellPath, commandExecutionTimeout, commandTimeoutAllowlist
  → **済**（PR #421）: PowershellCounter / ZshClearEolMark / ZshOhMy / ZshP10k を削除。zdotdir は core の
  シェル統合と密結合のため温存。残りは execute_command のコアなので保持。
- **モード / プロファイル**: mode, customModes, modeApiConfigs, currentApiConfigName, listApiConfigMeta,
  pinnedApiConfigs, enhancementApiConfigId, profileThresholds, hasOpenedModeSelector
- ~~**サウンド / TTS**: soundEnabled, soundVolume, ttsEnabled, ttsSpeed~~ → **済**（PR #422 で機能ごと全削除）
- **画像**: maxImageFileSize, maxTotalImageSize, lastImageSavePath
- **worktree**: showWorktreesInHomeScreen, worktreeAutoOpenPath
- **履歴 / エクスポート**: taskHistory, lastTaskExportPath, lastSettingsExportPath, lastModeExportPath, lastModeImportPath
- **UI 状態**: historyPreviewCollapsed, reasoningBlockCollapsed, dismissedUpsells, enterBehavior
- **チェックポイント**: enableCheckpoints → **要精査**（shadow git のコスト）
- **ルール**: customInstructions, enableSubfolderRules, showAgentIgnoredFiles
- **その他**: mcpEnabled, disabledTools（UI 無し）, preventCompletionWithOpenTodos, rateLimitSeconds, writeDelayMs

### B3. VS Code 設定（`src/package.json` contributes.configuration、17キー）

allowedCommands, deniedCommands, commandExecutionTimeout, commandTimeoutAllowlist,
preventCompletionWithOpenTodos, customStoragePath, enableCodeActions, autoImportSettingsPath,
maximumIndexedFilesForFileSearch, useAgentRules, apiRequestTimeout, newTaskRequireTodos,
codeIndex.embeddingBatchSize, debug, debugProxy.{enabled, serverUrl, tlsInsecure}

- **要精査**: debugProxy.\*（開発時 MITM 用・production 未使用）、codeIndex.\*。

---

## C. VS Code UI 面

### C1. コマンド（contributes.commands、23）

- タスク / 画面: plusButtonClicked, historyButtonClicked, popoutButtonClicked, settingsButtonClicked,
  openInNewTab, newTask, focusInput, acceptInput
- コードアクション: explainCode, fixCode, improveCode, addToContext
- ターミナル: terminalAddToContext, terminalFixCommand, terminalExplainCommand
- 自律モード: toggleAutoApprove, cycleAutonomyMode, setAutonomyMode{Manual, AutoEdit, Auto, Plan}（5コマンド）→ **要精査**
- 設定: setCustomStoragePath, importSettings

### C2. 設定タブ（`webview-ui/src/components/settings/SettingsView.tsx`、11）

providers / autoApprove / checkpoints / contextManagement / terminal / prompts / experimental /
language / about /（auto）

- **済**: notifications タブは PR #422（sound/tts 削除）で撤去。
- **要精査**: checkpoints, language を畳めるか。

---

## 整理方針（このインベントリ確定後）

1. **要精査**項目を「使う / 使わない」で仕分け（運用前提が要る）。
2. 使わないものを **設定 UI から隠す → コード / deps 撤去** の順で削減（挙動確認しながら）。
3. 効果が大きい順の目安: ~~マルチプロバイダ残骸~~（済） → ~~ターミナル（zsh / p10k）系~~（済） →
   ~~TTS / sound~~（済） → checkpoints → 自律モード群。

関連: [architecture.md](architecture.md) / [mcp.md](mcp.md) / [webview.md](webview.md)
