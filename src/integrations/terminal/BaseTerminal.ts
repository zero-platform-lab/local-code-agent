import { truncateOutput, applyRunLengthEncoding } from "../misc/extract-text"

import type {
	AgentTerminalProvider,
	AgentTerminal,
	AgentTerminalCallbacks,
	AgentTerminalProcess,
	AgentTerminalProcessResultPromise,
	ExitCodeDetails,
} from "./types"
import { DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS } from "@openai-agent/types"

export abstract class BaseTerminal implements AgentTerminal {
	public readonly provider: AgentTerminalProvider
	public readonly id: number
	public readonly initialCwd: string

	public busy: boolean
	public running: boolean
	protected streamClosed: boolean

	public taskId?: string
	public process?: AgentTerminalProcess
	public completedProcesses: AgentTerminalProcess[] = []

	constructor(provider: AgentTerminalProvider, id: number, cwd: string) {
		this.provider = provider
		this.id = id
		this.initialCwd = cwd
		this.busy = false
		this.running = false
		this.streamClosed = false
	}

	public getCurrentWorkingDirectory(): string {
		return this.initialCwd
	}

	abstract isClosed(): boolean

	abstract runCommand(command: string, callbacks: AgentTerminalCallbacks): AgentTerminalProcessResultPromise

	/**
	 * Sets the active stream for this terminal and notifies the process
	 * @param stream The stream to set, or undefined to clean up
	 * @throws Error if process is undefined when a stream is provided
	 */
	public setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void {
		if (stream) {
			if (!this.process) {
				this.running = false

				console.warn(
					`[Terminal ${this.provider}/${this.id}] process is undefined, so cannot set terminal stream (probably user-initiated non-Agent command)`,
				)

				return
			}

			this.running = true
			this.streamClosed = false
			this.process.emit("shell_execution_started", pid)
			this.process.emit("stream_available", stream)
		} else {
			this.streamClosed = true
		}
	}

	/**
	 * Handles shell execution completion for this terminal.
	 * @param exitDetails The exit details of the shell execution
	 */
	public shellExecutionComplete(exitDetails: ExitCodeDetails) {
		this.busy = false
		this.running = false

		if (this.process) {
			// Add to the front of the queue (most recent first).
			if (this.process.hasUnretrievedOutput()) {
				this.completedProcesses.unshift(this.process)
			}

			this.process.emit("shell_execution_complete", exitDetails)
			this.process = undefined
		}
	}

	public get isStreamClosed(): boolean {
		return this.streamClosed
	}

	/**
	 * Gets the last executed command
	 * @returns The last command string or empty string if none
	 */
	public getLastCommand(): string {
		// Return the command from the active process or the most recent process in the queue
		if (this.process) {
			return this.process.command || ""
		} else if (this.completedProcesses.length > 0) {
			return this.completedProcesses[0].command || ""
		}

		return ""
	}

	/**
	 * Cleans the process queue by removing processes that no longer have unretrieved output
	 * or don't belong to the current task
	 */
	public cleanCompletedProcessQueue(): void {
		// Trim retrieved output from each process to free memory, then keep only those with remaining output
		this.completedProcesses = this.completedProcesses.filter((process) => {
			process.trimRetrievedOutput()
			return process.hasUnretrievedOutput()
		})
	}

	/**
	 * Gets all processes with unretrieved output
	 * @returns Array of processes with unretrieved output
	 */
	public getProcessesWithOutput(): AgentTerminalProcess[] {
		// Clean the queue first to remove any processes without output
		this.cleanCompletedProcessQueue()
		return [...this.completedProcesses]
	}

	/**
	 * Gets all unretrieved output from both active and completed processes
	 * @returns Combined unretrieved output from all processes
	 */
	public getUnretrievedOutput(): string {
		let output = ""

		// First check completed processes to maintain chronological order
		for (const process of this.completedProcesses) {
			const processOutput = process.getUnretrievedOutput()

			if (processOutput) {
				output += processOutput
			}
		}

		// Then check active process for most recent output
		const activeOutput = this.process?.getUnretrievedOutput()

		if (activeOutput) {
			output += activeOutput
		}

		this.cleanCompletedProcessQueue()
		return output
	}

	public static defaultShellIntegrationTimeout = DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS
	private static shellIntegrationTimeout: number = BaseTerminal.defaultShellIntegrationTimeout
	private static shellIntegrationDisabled: boolean = false
	private static commandDelay: number = 0
	private static terminalZdotdir: boolean = false
	private static execaShellPath: string | undefined = undefined

	/**
	 * Compresses terminal output by applying run-length encoding and truncating to line limit
	 * @param input The terminal output to compress
	 * @returns The compressed terminal output
	 */
	public static setShellIntegrationTimeout(timeoutMs: number): void {
		BaseTerminal.shellIntegrationTimeout = timeoutMs
	}

	public static getShellIntegrationTimeout(): number {
		return BaseTerminal.shellIntegrationTimeout
	}

	public static setShellIntegrationDisabled(disabled: boolean): void {
		BaseTerminal.shellIntegrationDisabled = disabled
	}

	public static getShellIntegrationDisabled(): boolean {
		return BaseTerminal.shellIntegrationDisabled
	}

	/**
	 * Sets the command delay in milliseconds
	 * @param delayMs The delay in milliseconds
	 */
	public static setCommandDelay(delayMs: number): void {
		BaseTerminal.commandDelay = delayMs
	}

	/**
	 * Gets the command delay in milliseconds
	 * @returns The command delay in milliseconds
	 */
	public static getCommandDelay(): number {
		return BaseTerminal.commandDelay
	}

	/**
	 * Compresses terminal output by applying run-length encoding and truncating to reasonable limits.
	 * Uses hardcoded defaults: 500 lines, 50K characters - these are UI display limits to prevent
	 * memory issues, not LLM context limits (which are controlled by terminalOutputPreviewSize).
	 * @param input The terminal output to compress
	 * @returns The compressed terminal output
	 */
	public static compressTerminalOutput(input: string): string {
		// Hardcoded UI display limits - these prevent unbounded memory growth
		// in the chat display, separate from the LLM context limits
		const LINE_LIMIT = 500
		const CHARACTER_LIMIT = 50_000

		return truncateOutput(applyRunLengthEncoding(input), LINE_LIMIT, CHARACTER_LIMIT)
	}

	/**
	 * Sets whether to enable ZDOTDIR handling for zsh
	 * @param enabled Whether to enable ZDOTDIR handling
	 */
	public static setTerminalZdotdir(enabled: boolean): void {
		BaseTerminal.terminalZdotdir = enabled
	}

	/**
	 * Gets whether ZDOTDIR handling is enabled
	 * @returns Whether ZDOTDIR handling is enabled
	 */
	public static getTerminalZdotdir(): boolean {
		return BaseTerminal.terminalZdotdir
	}

	public static setExecaShellPath(shellPath: string | undefined): void {
		BaseTerminal.execaShellPath = shellPath
	}

	public static getExecaShellPath(): string | undefined {
		return BaseTerminal.execaShellPath
	}
}
