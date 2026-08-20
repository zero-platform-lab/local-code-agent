/**
 * Task の grace retry 系 counter を凝集した collaborator。
 *
 * 元は Task class に 2 field（`consecutiveNoAssistantMessagesCount` /
 * `consecutiveNoToolUseCount`）+ 各所での手動リセット/インクリメントで散らばっていた。
 *
 * - `consecutiveNoAssistantMessagesCount`: assistant 応答が空だった連続回数
 *   （2 に達したら task を中断する retry limit）
 * - `consecutiveNoToolUseCount`: 直近の応答で tool を使わなかった連続回数
 *   （2 に達したら「tool 呼べ」の followup prompt を投げる）
 *
 * 責務: increment / reset / read。abort 時は両方 reset。
 */
export class GraceRetryCounter {
	/** assistant 応答が空だった連続回数。2 に達したら task 中断。 */
	noAssistantMessages = 0

	/** 応答で tool を使わなかった連続回数。2 に達したら「tool 使え」followup を投げる。 */
	noToolUse = 0

	/** abort 時に両方 reset する（runAbortTask で使用）。 */
	resetAll(): void {
		this.noAssistantMessages = 0
		this.noToolUse = 0
	}
}
