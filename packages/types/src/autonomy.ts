import { z } from "zod"

/**
 * Autonomy modes control how much the agent does *without asking*, à la Claude Code's
 * permission modes. They are a different axis from role modes (Code / Architect / ...),
 * which control *what job* the agent does and *which tools* it may touch.
 *
 * IMPORTANT: autonomy is user-controlled ONLY. The model must never be able to raise its
 * own autonomy level — otherwise the destructive-command denylist could be bypassed.
 */
export const autonomyModes = ["manual", "autoEdit", "auto", "plan"] as const

export const autonomyModeSchema = z.enum(autonomyModes)

export type AutonomyMode = z.infer<typeof autonomyModeSchema>

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "manual"

/** Order used when cycling with the keyboard shortcut / badge click. */
export const AUTONOMY_MODE_CYCLE: readonly AutonomyMode[] = ["manual", "autoEdit", "auto", "plan"] as const

/**
 * Read-only autonomy modes. In these modes the agent may investigate (read/search) but
 * must not change files, run commands, or otherwise mutate state — enforced at the
 * tool-validation layer, independent of the role mode.
 */
export const READ_ONLY_AUTONOMY_MODES: readonly AutonomyMode[] = ["plan"] as const

export function isReadOnlyAutonomyMode(mode: AutonomyMode | undefined): boolean {
	return !!mode && READ_ONLY_AUTONOMY_MODES.includes(mode)
}

/**
 * The auto-approval flags each mode applies. Applying a mode overwrites exactly these
 * keys and nothing else — command policy (allowedCommands / deniedCommands), the
 * *OutsideWorkspace / *Protected escalations, and followup handling stay under the
 * user's explicit control so switching modes never silently widens them.
 */
export type AutonomyPreset = {
	autoApprovalEnabled: boolean
	alwaysAllowReadOnly: boolean
	alwaysAllowWrite: boolean
	alwaysAllowExecute: boolean
	alwaysAllowMcp: boolean
	alwaysAllowSubtasks: boolean
}

export const AUTONOMY_PRESETS: Record<AutonomyMode, AutonomyPreset> = {
	// Ask before every action.
	manual: {
		autoApprovalEnabled: false,
		alwaysAllowReadOnly: false,
		alwaysAllowWrite: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowSubtasks: false,
	},
	// Auto-approve reads and edits; still ask before running commands
	// (equivalent to Claude Code's "auto-accept edits").
	autoEdit: {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: true,
		alwaysAllowExecute: false,
		alwaysAllowMcp: true,
		alwaysAllowSubtasks: true,
	},
	// Fully autonomous: reads, edits, and *allowed* commands run without asking.
	// Destructive commands remain blocked by deniedCommands; running arbitrary commands
	// still requires the user to opt in via allowedCommands (e.g. "*").
	auto: {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: true,
		alwaysAllowExecute: true,
		alwaysAllowMcp: true,
		alwaysAllowSubtasks: true,
	},
	// Read-only planning: reads flow without asking, but edits/commands are blocked
	// entirely at the tool-validation layer (see isReadOnlyAutonomyMode). The write/
	// execute flags are false so nothing mutating could be auto-approved even if the
	// gate were bypassed.
	plan: {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowSubtasks: false,
	},
}

/** The next mode in the cycle order, wrapping around. */
export function nextAutonomyMode(current: AutonomyMode | undefined): AutonomyMode {
	const order = AUTONOMY_MODE_CYCLE
	const index = current ? order.indexOf(current) : -1
	return order[(index + 1) % order.length] as AutonomyMode
}

/**
 * Destructive command prefixes that should never be auto-approved, even in `auto` mode.
 * Shipped as the default value of the `deniedCommands` setting. Uses the same
 * longest-prefix, chain-aware matching as the rest of the command denylist.
 */
export const DEFAULT_DENIED_COMMANDS: readonly string[] = [
	"rm -rf",
	"rm -fr",
	"sudo",
	"dd",
	"mkfs",
	"shred",
	":(){",
	"chmod -R 777",
	"chown -R",
	"git push --force",
	"git push -f",
	"git reset --hard",
	"git clean -fd",
	"curl", // piping remote scripts into a shell; keep denied by default
	"wget",
	"npm publish",
	"pnpm publish",
	"yarn publish",
]
