import type { AutonomyMode } from "@openai-agent/types"

/**
 * 自律モードを **モデルに伝える** ためのセクション。
 *
 * 自律モードは承認ゲート（`AUTONOMY_PRESETS` の `alwaysAllow*`）と、plan における
 * ツール層での遮断（`validateToolUse` / `isReadOnlyAutonomyMode`）として実装されている。
 * どちらもモデルからは見えないため、これが無いと plan のモデルは自分が読み取り専用だと
 * 知らないまま編集を試み、毎回ツール層で弾かれてターンを捨てる。
 *
 * ここに書く内容は `AUTONOMY_PRESETS` の実際の値と一致していなければならない。
 * プリセットを変えたらこの文面も直すこと。
 */
const AUTONOMY_DESCRIPTIONS: Record<AutonomyMode, string> = {
	manual: `The current autonomy mode is **Manual**.

Every tool use requires the user's explicit approval before it runs. Expect an approval prompt between each step. Because each approval costs the user an interaction, prefer fewer, well-chosen tool calls over many small exploratory ones, and explain what you are about to do when the reason is not obvious from the call itself.`,

	autoEdit: `The current autonomy mode is **Auto-Edit**.

Reading files and editing files run without asking. Running commands still requires the user's approval each time. Proceed through reads and edits without pausing for confirmation, and batch your command usage so the user is interrupted as little as possible.`,

	auto: `The current autonomy mode is **Auto**.

Reading files, editing files, and running allowed commands all run without asking. This is not unrestricted: commands matching the user's denied-command list are blocked outright, and commands outside the allowed list still require approval. Work through the task continuously and only stop when it is done or genuinely blocked.`,

	plan: `The current autonomy mode is **Plan**, which is read-only.

You may read, search, and investigate. File edits and command execution are **rejected by the tool-validation layer before they run** — attempting them wastes a turn and cannot succeed, so do not attempt them. This restriction is enforced independently of the role mode and only the user can lift it.

Produce a plan instead of an implementation:

- Investigate enough to make the plan concrete, and ask the user clarifying questions when the task is ambiguous.
- Record the plan with the update_todo_list tool. Each item should be specific, actionable, ordered, and scoped to a single outcome.
- Do not give time or effort estimates.
- When the plan is ready, present it and ask the user to leave Plan mode to carry it out. Never ask to raise your own autonomy level as part of the plan — switching modes is the user's decision alone.`,
}

/**
 * 現在の自律モードを説明するセクションを返す。モードが未指定なら空文字（呼び出し側で落とす）。
 */
export function getAutonomySection(autonomyMode?: AutonomyMode): string {
	if (!autonomyMode) {
		return ""
	}

	return `====

AUTONOMY MODE

${AUTONOMY_DESCRIPTIONS[autonomyMode]}`
}
