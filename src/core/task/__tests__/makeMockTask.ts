import { vi } from "vitest"

import type { Task } from "../Task"
import { AskState } from "../AskState"
import { GraceRetryCounter } from "../GraceRetryCounter"
import { MistakeTracker } from "../MistakeTracker"
import { StreamingSession } from "../StreamingSession"

/**
 * tool test 群で使い回す mock Task ヘルパ。18+ files で重複していた
 * `mockTask: any = {}` + 数十行の setup を吸収する。
 *
 * デフォルトで 4 collaborator（AskState / GraceRetryCounter / MistakeTracker /
 * StreamingSession）を実インスタンスで持ち、tool test が期待する最小 API
 * （ask / say / sayAndCreateMissingParamError / recordToolError / providerRef 等）を
 * `vi.fn()` で埋める。個別テストは `overrides` で必要な field だけ上書き。
 *
 * `as unknown as Task` cast で Task 型を満たす扱いにするが、実際は Partial<Task>
 * 相当（触らない field は undefined）。test-only helper なので型安全性より
 * `mockTask.foo = ...` の柔軟性を優先する。
 */
export interface MakeMockTaskOptions {
	cwd?: string
	consecutiveMistakeLimit?: number
	providerState?: unknown
	overrides?: Partial<Task>
}

export function makeMockTask(options: MakeMockTaskOptions = {}): Task {
	const { cwd = "/test/workspace", consecutiveMistakeLimit = 3, providerState, overrides = {} } = options

	const base = {
		// Identity
		taskId: "test-task-id",
		instanceId: "test-instance-id",
		cwd,

		// Collaborators (real instances so field mutation works naturally)
		askState: new AskState(),
		graceRetry: new GraceRetryCounter(),
		mistakeTracker: new MistakeTracker(consecutiveMistakeLimit),
		stream: new StreamingSession(),

		// Common UI callbacks (vi.fn stubs)
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
		say: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
		handleWebviewAskResponse: vi.fn(),

		// Common state mutators。ツール使用量は TokenUsageTracker が所有するので
		// `mockTask.tokenUsageTracker.recordToolError` に対して assert する。
		tokenUsageTracker: {
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolUsage: {},
			getTokenUsage: vi.fn().mockReturnValue({}),
			getCachedTokenUsage: vi.fn().mockReturnValue({}),
			emitFinal: vi.fn(),
			emitDebounced: vi.fn(),
			flush: vi.fn(),
		},
		didEditFile: false,

		// Provider access — deref returns a fake with getState + postMessageToWebview
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue(providerState ?? {}),
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			}),
		},

		// Ignore/protect controllers — allow all by default
		rooIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(true),
			validateCommand: vi.fn().mockReturnValue(null),
		},
		rooProtectedController: {
			isWriteProtected: vi.fn().mockReturnValue(false),
		},

		// File context tracker
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
			getAndClearRecentlyModifiedFiles: vi.fn().mockReturnValue([]),
		},

		// Message plumbing
		processQueuedMessages: vi.fn(),
	}

	return { ...base, ...overrides } as unknown as Task
}
