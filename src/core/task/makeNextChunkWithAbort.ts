/**
 * ストリーム iterator の `.next()` を、AbortController の signal と race させる helper を作る。
 *
 * `recursivelyMakeClineRequests` の while ループで使う。呼び出し時点の
 * `AbortController` を毎回 `getAbortController()` で取り直すので、request の途中で
 * controller が差し替わっても対応する。
 *
 * controller が undefined のときは素の `iterator.next()` をそのまま返す。
 */
export function makeNextChunkWithAbort<T>(
	iterator: AsyncIterator<T>,
	getAbortController: () => AbortController | undefined,
): () => Promise<IteratorResult<T>> {
	return async () => {
		const nextPromise = iterator.next()

		const controller = getAbortController()
		if (controller) {
			const abortPromise = new Promise<never>((_, reject) => {
				const signal = controller.signal
				if (signal.aborted) {
					reject(new Error("Request cancelled by user"))
				} else {
					const onAbort = () => reject(new Error("Request cancelled by user"))
					signal.addEventListener("abort", onAbort, { once: true })
					// このチャンクが先に解決したら不要になったリスナを外す（長いストリームでの蓄積を防ぐ）。
					void nextPromise.finally(() => signal.removeEventListener("abort", onAbort))
				}
			})
			return await Promise.race([nextPromise, abortPromise])
		}

		// No abort controller, just return the next chunk normally
		return await nextPromise
	}
}
