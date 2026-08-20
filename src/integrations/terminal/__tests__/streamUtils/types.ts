// streamUtils/types.ts
//
// Leaf module holding the shared `CommandStream` shape so that the individual
// stream files (bash/cmd/pwsh/mock) can consume it without importing back from
// `./index` (which imports each stream file), breaking the barrel cycle.

/**
 * Common interface for all command streams
 */
export interface CommandStream {
	stream: AsyncIterable<string>
	exitCode: number
}
