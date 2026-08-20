import EventEmitter from "events"

export type AgentTerminalProvider = "vscode" | "execa"

export interface AgentTerminal {
	provider: AgentTerminalProvider
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	process?: AgentTerminalProcess
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (command: string, callbacks: AgentTerminalCallbacks) => AgentTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(exitDetails: ExitCodeDetails): void
	getProcessesWithOutput(): AgentTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
}

export interface AgentTerminalCallbacks {
	onLine: (line: string, process: AgentTerminalProcess) => void
	onCompleted: (output: string | undefined, process: AgentTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: AgentTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: AgentTerminalProcess) => void
	onNoShellIntegration?: (message: string, process: AgentTerminalProcess) => void
}

export interface AgentTerminalProcess extends EventEmitter<AgentTerminalProcessEvents> {
	command: string
	isHot: boolean
	run: (command: string) => Promise<void>
	continue: () => void
	abort: () => void
	hasUnretrievedOutput: () => boolean
	getUnretrievedOutput: () => string
	trimRetrievedOutput: () => void
}

export type AgentTerminalProcessResultPromise = AgentTerminalProcess & Promise<void>

export interface AgentTerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: [output?: string]
	stream_available: [stream: AsyncIterable<string>]
	shell_execution_started: [pid: number | undefined]
	shell_execution_complete: [exitDetails: ExitCodeDetails]
	error: [error: Error]
	no_shell_integration: [message: string]
}

export interface ExitCodeDetails {
	exitCode: number | undefined
	signal?: number | undefined
	signalName?: string
	coreDumpPossible?: boolean
}
