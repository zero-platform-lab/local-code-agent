// npx vitest run core/task/__tests__/TaskSubscriptions.spec.ts

import { AgentEventName } from "@openai-agent/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"

import { TaskSubscriptions, type TaskSubscription } from "../TaskSubscriptions"
import { subscribeMessageQueueStateChanged } from "../subscribeMessageQueueStateChanged"
import { subscribeProviderProfileChange } from "../subscribeProviderProfileChange"

const makeSubscription = (label: string, dispose = vi.fn()): TaskSubscription => ({ label, dispose })

describe("TaskSubscriptions", () => {
	it("registers subscriptions and exposes their labels", () => {
		const subscriptions = new TaskSubscriptions()
		subscriptions.add(makeSubscription("a"))
		subscriptions.add(makeSubscription("b"))

		expect(subscriptions.size).toBe(2)
		expect(subscriptions.labels).toEqual(["a", "b"])
		expect(subscriptions.isDisposed).toBe(false)
	})

	it("ignores undefined (a subscription that was never established)", () => {
		const subscriptions = new TaskSubscriptions()
		subscriptions.add(undefined)

		expect(subscriptions.size).toBe(0)
	})

	it("disposes every registered subscription once and clears the registry", () => {
		const subscriptions = new TaskSubscriptions()
		const first = vi.fn()
		const second = vi.fn()
		subscriptions.add(makeSubscription("first", first))
		subscriptions.add(makeSubscription("second", second))

		subscriptions.disposeAll()

		expect(first).toHaveBeenCalledOnce()
		expect(second).toHaveBeenCalledOnce()
		expect(subscriptions.size).toBe(0)
		expect(subscriptions.isDisposed).toBe(true)

		// Second disposeAll must not re-run teardowns.
		subscriptions.disposeAll()
		expect(first).toHaveBeenCalledOnce()
		expect(second).toHaveBeenCalledOnce()
	})

	it("keeps disposing the rest when one teardown throws, and never throws itself", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const subscriptions = new TaskSubscriptions()
		const after = vi.fn()
		subscriptions.add(
			makeSubscription(
				"exploding",
				vi.fn(() => {
					throw new Error("boom")
				}),
			),
		)
		subscriptions.add(makeSubscription("after", after))

		expect(() => subscriptions.disposeAll()).not.toThrow()
		expect(after).toHaveBeenCalledOnce()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Error disposing task subscription (exploding):",
			expect.any(Error),
		)

		consoleErrorSpy.mockRestore()
	})

	it("immediately tears down a subscription added after disposeAll", () => {
		const subscriptions = new TaskSubscriptions()
		subscriptions.disposeAll()

		const late = vi.fn()
		subscriptions.add(makeSubscription("late", late))

		expect(late).toHaveBeenCalledOnce()
		expect(subscriptions.size).toBe(0)
	})
})

describe("subscribeMessageQueueStateChanged", () => {
	const makeHost = () => {
		const postStateToWebviewWithoutTaskHistory = vi.fn()
		return {
			taskId: "task-1",
			messageQueueService: new MessageQueueService(),
			emit: vi.fn(),
			providerRef: {
				deref: () => ({ postStateToWebviewWithoutTaskHistory }),
			} as unknown as WeakRef<{ postStateToWebviewWithoutTaskHistory(): Promise<void> | void }>,
			postStateToWebviewWithoutTaskHistory,
		}
	}

	it("re-emits task events and refreshes the webview on stateChanged", () => {
		const host = makeHost()
		subscribeMessageQueueStateChanged(host)

		host.messageQueueService.addMessage("hello")

		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskUserMessage, "task-1")
		expect(host.emit).toHaveBeenCalledWith(
			AgentEventName.QueuedMessagesUpdated,
			"task-1",
			host.messageQueueService.messages,
		)
		expect(host.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledOnce()
	})

	it("stops reacting once the returned subscription is disposed", () => {
		const host = makeHost()
		const subscription = subscribeMessageQueueStateChanged(host)

		subscription.dispose()
		host.messageQueueService.addMessage("hello")

		expect(host.emit).not.toHaveBeenCalled()
		expect(host.messageQueueService.listenerCount("stateChanged")).toBe(0)
	})

	it("tolerates a collected provider", () => {
		const host = { ...makeHost(), providerRef: { deref: () => undefined } as unknown as WeakRef<any> }
		subscribeMessageQueueStateChanged(host)

		expect(() => host.messageQueueService.addMessage("hello")).not.toThrow()
	})
})

describe("subscribeProviderProfileChange", () => {
	const makeProvider = (state: unknown = { apiConfiguration: { apiProvider: "openai" } }) => {
		const listeners: Record<string, ((...args: any[]) => void)[]> = {}
		return {
			listeners,
			on: vi.fn((event: string, listener: (...args: any[]) => void) => {
				;(listeners[event] ??= []).push(listener)
			}),
			off: vi.fn((event: string, listener: (...args: any[]) => void) => {
				listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== listener)
			}),
			getState: vi.fn(async () => state),
			emitProfileChanged: async () => {
				await Promise.all((listeners[AgentEventName.ProviderProfileChanged] ?? []).map((fn) => fn()))
			},
		}
	}

	const host = () => ({ taskId: "task-1", instanceId: "abcd1234", updateApiConfiguration: vi.fn() })

	it("applies the new api configuration when the provider profile changes", async () => {
		const provider = makeProvider()
		const taskHost = host()

		const subscription = subscribeProviderProfileChange(taskHost, new WeakRef(provider) as any)

		expect(subscription?.label).toBe("provider.providerProfileChanged")
		await provider.emitProfileChanged()

		expect(taskHost.updateApiConfiguration).toHaveBeenCalledWith({ apiProvider: "openai" })
	})

	it("returns undefined when the provider has no emitter surface", () => {
		const taskHost = host()

		const subscription = subscribeProviderProfileChange(taskHost, new WeakRef({ getState: vi.fn() } as any))

		expect(subscription).toBeUndefined()
	})

	it("returns undefined when the provider was already collected", () => {
		const subscription = subscribeProviderProfileChange(host(), { deref: () => undefined } as any)

		expect(subscription).toBeUndefined()
	})

	it("removes the provider listener on dispose", async () => {
		const provider = makeProvider()
		const taskHost = host()

		const subscription = subscribeProviderProfileChange(taskHost, new WeakRef(provider) as any)
		subscription?.dispose()

		expect(provider.off).toHaveBeenCalledWith(AgentEventName.ProviderProfileChanged, expect.any(Function))
		await provider.emitProfileChanged()
		expect(taskHost.updateApiConfiguration).not.toHaveBeenCalled()
	})

	it("swallows provider.getState() failures", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const provider = makeProvider()
		provider.getState.mockRejectedValueOnce(new Error("nope"))
		const taskHost = host()

		subscribeProviderProfileChange(taskHost, new WeakRef(provider) as any)
		await provider.emitProfileChanged()

		expect(taskHost.updateApiConfiguration).not.toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[Task#task-1.abcd1234] Failed to update API configuration on profile change:",
			expect.any(Error),
		)

		consoleErrorSpy.mockRestore()
	})

	it("does not apply state without an apiConfiguration", async () => {
		const provider = makeProvider({})
		const taskHost = host()

		subscribeProviderProfileChange(taskHost, new WeakRef(provider) as any)
		await provider.emitProfileChanged()

		expect(taskHost.updateApiConfiguration).not.toHaveBeenCalled()
	})
})
