import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import {
	buildSkillApprovalMessage,
	buildSkillResult,
	resolveSkillContentForMode,
	type SkillLookup,
} from "../../services/skills/skillInvocation"
import type { ToolTaskContext } from "./toolHost"

interface SkillParams {
	skill: string
	args?: string
}

/** Skill-manager members used here (extends the lookup passed to resolveSkillContentForMode). */
interface SkillManagerLike extends SkillLookup {
	getSkillsForMode(mode: string): { name: string }[]
}

interface SkillProviderLike {
	getSkillsManager(): SkillManagerLike | undefined
	getState(): Promise<{ mode?: string }>
}

/** Narrow structural view of `Task` required by {@link SkillTool}. */
interface SkillHost extends ToolTaskContext {
	stream: {
		didToolFailInCurrentTurn: boolean
	}
	readonly providerRef: WeakRef<SkillProviderLike>
}

export class SkillTool extends BaseTool<"skill"> {
	readonly name = "skill" as const

	async execute(params: SkillParams, task: SkillHost, callbacks: ToolCallbacks): Promise<void> {
		const { skill: skillName, args } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate skill name parameter
			if (!skillName) {
				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("skill")
				task.stream.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("skill", "skill"))
				return
			}

			task.mistakeTracker.count = 0

			// Get SkillsManager from provider
			const provider = task.providerRef.deref()
			const skillsManager = provider?.getSkillsManager()

			if (!skillsManager) {
				task.tokenUsageTracker.recordToolError("skill")
				task.stream.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("Skills Manager not available"))
				return
			}

			// Get current mode for skill resolution
			const state = await provider?.getState()
			const currentMode = state?.mode ?? "code"

			// Fetch skill content
			const skillContent = await resolveSkillContentForMode(skillsManager, skillName, currentMode)

			if (!skillContent) {
				// Get available skills for error message
				const availableSkills = skillsManager.getSkillsForMode(currentMode)
				const skillNames = availableSkills.map((s) => s.name)

				task.tokenUsageTracker.recordToolError("skill")
				task.stream.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Skill '${skillName}' not found. Available skills: ${skillNames.join(", ") || "(none)"}`,
					),
				)
				return
			}

			// Build approval message
			const toolMessage = buildSkillApprovalMessage(skillName, args, skillContent)

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(buildSkillResult(skillName, args, skillContent))
		} catch (error) {
			await handleError("executing skill", error as Error)
		}
	}

	override async handlePartial(task: SkillHost, block: ToolUse<"skill">): Promise<void> {
		const skillName: string | undefined = block.params.skill
		const args: string | undefined = block.params.args

		const partialMessage = JSON.stringify({
			tool: "skill",
			skill: skillName,
			args: args,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const skillTool = new SkillTool()
