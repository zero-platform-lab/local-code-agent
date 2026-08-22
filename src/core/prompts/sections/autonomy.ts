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

interface AutonomyPromptContext {
	/** `update_todo_list` が提示されているか（`todoListEnabled === false` で外れる） */
	todoListEnabled: boolean
}

/**
 * plan の計画手順。役割モード architect の `customInstructions` から移したもの。
 *
 * 移送に際して落とした項目が 2 つある:
 * - 実装モードへ移るようモデルから促す指示。自律レベルはユーザーの専権なので、
 *   モデルからの移行要求ではなく「ユーザーが Plan を抜ける」と表現する。
 * - 計画を markdown ファイルへ書き出す指示（`/plans` 配下・`update_todo_list` 不在時の
 *   代替）。plan では edit グループごと遮断されるため、そもそも書けない。
 */
function planInstructions({ todoListEnabled }: AutonomyPromptContext): string {
	const record = todoListEnabled
		? `- Record the plan with the update_todo_list tool. Each item should be:
  - Specific and actionable
  - Listed in logical execution order
  - Focused on a single, well-defined outcome
  - Clear enough that someone else could execute it independently
- Keep the todo list current as you gather information or discover new requirements.
- Prefer a clear, actionable todo list over a lengthy prose document. The todo list is your primary planning tool.`
		: `- Present the plan directly in your response as a short ordered list. Each step should be specific, actionable, scoped to a single outcome, and clear enough that someone else could execute it independently.
- Restate the updated plan when you gather information or discover new requirements.
- Keep it a tight list of steps rather than a lengthy prose document. You cannot write it to a file in this mode.`

	return `Produce a plan instead of an implementation:

- Investigate enough to make the plan concrete, and ask the user clarifying questions when the task is ambiguous.
${record}
- Include a Mermaid diagram when it clarifies a complex workflow or the shape of the system. Avoid double quotes ("") and parentheses () inside square brackets ([]) in Mermaid — they cause parse errors.
- Never give time or effort estimates (hours, days, weeks). Break the work down without estimating how long it takes.
- When the plan is ready, present it and ask whether the user is satisfied or wants changes — treat it as a brainstorming session you can refine together. To carry the plan out, the user leaves Plan mode themselves. Never ask to raise your own autonomy level; switching modes is the user's decision alone.`
}

const AUTONOMY_DESCRIPTIONS: Record<AutonomyMode, (ctx: AutonomyPromptContext) => string> = {
	manual: () => `The current autonomy mode is **Manual**.

Every tool use requires the user's explicit approval before it runs. Expect an approval prompt between each step. Because each approval costs the user an interaction, prefer fewer, well-chosen tool calls over many small exploratory ones, and explain what you are about to do when the reason is not obvious from the call itself.`,

	autoEdit: () => `The current autonomy mode is **Auto-Edit**.

Reading files and editing files run without asking. Running commands still requires the user's approval each time. Proceed through reads and edits without pausing for confirmation, and batch your command usage so the user is interrupted as little as possible.`,

	auto: () => `The current autonomy mode is **Auto**.

Reading files, editing files, and running allowed commands all run without asking. This is not unrestricted: commands matching the user's denied-command list are blocked outright, and commands outside the allowed list still require approval. Work through the task continuously and only stop when it is done or genuinely blocked.`,

	plan: (ctx) => `The current autonomy mode is **Plan**, which is read-only.

You may read, search, and investigate. File edits and command execution are **rejected by the tool-validation layer before they run** — attempting them wastes a turn and cannot succeed, so do not attempt them. This restriction is enforced independently of the role mode and only the user can lift it.

${planInstructions(ctx)}`,
}

/**
 * 現在の自律モードを説明するセクションを返す。モードが未指定なら空文字（呼び出し側で落とす）。
 */
export function getAutonomySection(autonomyMode?: AutonomyMode, todoListEnabled: boolean = true): string {
	if (!autonomyMode) {
		return ""
	}

	return `====

AUTONOMY MODE

${AUTONOMY_DESCRIPTIONS[autonomyMode]({ todoListEnabled })}`
}
