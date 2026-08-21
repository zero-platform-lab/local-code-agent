import OpenAI, { AzureOpenAI } from "openai"

import type { Dispatcher } from "undici"

import { getProxyDispatcher, fetchThrough, type ProxyOverride } from "../../utils/proxyDispatcher"
import { fetch as undiciFetch } from "undici"

import {
	type ModelInfo,
	type AgentMessage,
	azureOpenAiDefaultApiVersion,
	openAiModelInfoSaneDefaults,
	OPENAI_AZURE_AI_INFERENCE_PATH,
} from "@openai-agent/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"

import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../types"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/openai-error-handler"

/**
 * ストリームの delta から推論テキストを取り出す。
 *
 * 置き場所がサーバによって違う:
 *   - OpenAI / DeepSeek 系 … `reasoning_content`
 *   - Ollama              … `reasoning`
 *
 * どちらも SDK の型には無いので、実体を見て拾う。片方しか見ないと、その
 * サーバの思考表示だけが黙って消える（実際 Ollama で消えていた）。
 */
function readReasoningText(delta: unknown): string | undefined {
	const candidate = delta as { reasoning_content?: unknown; reasoning?: unknown } | null | undefined
	const text = candidate?.reasoning_content ?? candidate?.reasoning

	return typeof text === "string" && text.length > 0 ? text : undefined
}

/**
 * 失敗したリクエストの「送った要点」を 1 行にまとめる。messages の本文は載せない
 * （機密・サイズのため）。400 の切り分けに効くパラメータだけを出す。
 */
function summarizeSentRequest(reqObj: object): string {
	const req = reqObj as Record<string, unknown>
	const keys = [
		"model",
		"temperature",
		"reasoning_effort",
		"stream",
		"stream_options",
		"tool_choice",
		"parallel_tool_calls",
		"max_completion_tokens",
		"max_tokens",
	]
	const parts = keys
		.filter((k) => k in req)
		.map((k) => `${k}=${typeof req[k] === "object" ? JSON.stringify(req[k]) : req[k]}`)
	if (Array.isArray((req as { tools?: unknown }).tools)) {
		parts.push(`tools=${(req as { tools: unknown[] }).tools.length}`)
	}
	return parts.join(", ")
}

/**
 * エラーに「実際に送った要点」を添える。エラーメッセージ末尾に `[sent] ...` を足し、
 * 構造化アクセス用に `sentRequestSummary` も付ける。送信内容が見えないと 400 の
 * 切り分けができないため（実リクエストのエラーには従来これが無かった）。
 */
function attachSentRequest(err: Error, req: object): Error {
	const summary = summarizeSentRequest(req)
	;(err as unknown as { sentRequestSummary?: string }).sentRequestSummary = summary
	err.message = `${err.message}\n[sent] ${summary}`
	return err
}

// TODO: Rename this to OpenAICompatibleHandler. Also, I think the
// `OpenAINativeHandler` can subclass from this, since it's obviously
// compatible with the OpenAI API. We can also rename it to `OpenAIHandler`.
/**
 * API 設定プロファイルの proxy 指定を dispatcher 用の形へ落とす。
 *
 * 全体設定ではなくプロファイル側を見るのは、SOCKS 経由のモデルと直結のモデルが
 * 同一環境に混在するため。全体で 1 つしか持てないと、片方が必ず通らない。
 */
function proxyOverrideOf(options: Pick<ApiHandlerOptions, "openAiProxyMode" | "openAiProxyUrl">): ProxyOverride {
	return { mode: options.openAiProxyMode, url: options.openAiProxyUrl }
}

export class OpenAiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected client: OpenAI
	private readonly providerName = "OpenAI"
	// リクエストのタイムアウト（ms）。コンストラクタで一度だけ読む。
	// 実リクエストの AbortController ウォッチドッグに使う（SDK client timeout が
	// この環境で発火せずハングする事例があったため、自前で確実に中断する）。
	private readonly requestTimeoutMs: number | undefined

	// Responses API 経路で受け取った reasoning items（encrypted_content 付き）を
	// 保持し、Task 側の会話履歴保存フック（`getEncryptedContent()`）から拾わせる。
	// 1 リクエストの応答で得た reasoning items をまとめて 1 個の string にせず、
	// **最後の 1 個だけ** を返す簡易実装から始める（addToApiConversationHistory の
	// 既存契約は encrypted_content: string 1 個を想定）。
	// 複数 reasoning items がある場合の順序保証は後続で強化する。
	private lastResponsesReasoning: { encrypted_content: string; id?: string } | undefined
	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		return this.lastResponsesReasoning
	}

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const baseURL = (this.options.openAiBaseUrl || "https://api.openai.com/v1").trim()
		const apiKey = this.options.openAiApiKey ?? "not-provided"
		const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const urlHost = this._getUrlHost(this.options.openAiBaseUrl)
		const isAzureOpenAi = urlHost === "azure.com" || urlHost.endsWith(".azure.com") || options.openAiUseAzure

		const headers = {
			...DEFAULT_HEADERS,
			...(this.options.openAiHeaders || {}),
		}

		const timeout = getApiRequestTimeout()
		this.requestTimeoutMs = timeout

		// 企業 proxy 尊重（VS Code の http.proxy / HTTPS_PROXY 等）。
		// SDK は内部で built-in fetch を使うが、それは HTTPS_PROXY を自動では見ないため
		// dispatcher を渡す。ただし **VS Code は拡張ホストのグローバル fetch を差し替えて
		// おり、差し替え版は dispatcher を認識しない**（proxyDispatcher.ts の fetchThrough
		// 参照）。そのため dispatcher を渡すときは fetch 実装ごと undici のものにする。
		const proxyDispatcher = getProxyDispatcher(proxyOverrideOf(this.options))
		const fetchOptions: { dispatcher: Dispatcher } | undefined = proxyDispatcher
			? { dispatcher: proxyDispatcher }
			: undefined
		// dispatcher が無いときは触らない。そこは VS Code の proxy 解決に委ねる場所。
		const clientFetch = proxyDispatcher ? (undiciFetch as unknown as typeof fetch) : undefined

		if (isAzureAiInference) {
			// Azure AI Inference Service (e.g., for DeepSeek) uses a different path structure
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				defaultQuery: { "api-version": this.options.azureApiVersion || "2024-05-01-preview" },
				timeout,
				fetchOptions,
				...(clientFetch ? { fetch: clientFetch } : {}),
			})
		} else if (isAzureOpenAi) {
			// Azure API shape slightly differs from the core API shape:
			// https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
			this.client = new AzureOpenAI({
				baseURL,
				apiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
				defaultHeaders: headers,
				timeout,
				fetchOptions,
				...(clientFetch ? { fetch: clientFetch } : {}),
			})
		} else {
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout,
				fetchOptions,
				...(clientFetch ? { fetch: clientFetch } : {}),
			})
		}
	}

	/**
	 * chat.completions のリクエストで streaming / 非ストリーミング両経路が共有する
	 * パラメータを 1 箇所で組み立てる。
	 *
	 * ここに集約する理由: 以前は streaming と非ストリーミングでリクエストを別々に
	 * 手書きしており、`reasoning_effort` や `temperature` を片方だけに足して他方で
	 * 落とす drift が実際に起きた（GPT-5.6 の 400）。共通化して「一度書けば両経路に
	 * 効く」ようにし、経路差は stream / stream_options だけにする。
	 *
	 * temperature の扱い: 余計な param で 400 を招かないため、**ユーザーが明示的に設定した
	 * ときだけ** 送る（未設定はサーバ既定に委ねる）。reasoning モデル（reasoning_effort を
	 * 送る構成）は temperature を既定 (1) 以外にすると 400 になるため、reasoning のときは
	 * 明示設定があっても送らない。
	 */
	protected buildCommonChatParams(
		modelId: string,
		messages: OpenAI.Chat.ChatCompletionMessageParam[],
		metadata: ApiHandlerCreateMessageMetadata | undefined,
		reasoning: { reasoning_effort?: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] } | undefined,
	): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
		const base: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
			model: modelId,
			messages,
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}
		if (reasoning) {
			// GPT-5.x の chat/completions は **reasoning_effort + 関数ツールの併用が非対応**。
			// （公式: gpt-5.x で function tools を使うなら /v1/responses を使うか、reasoning_effort を
			// "none" にする。reasoning を効かせたまま tools を送ると、reasoning に時間を取られて
			// first-token が返らず**無音ハング**、または 400 になる。実際 Azure GPT-5.6 のツール時
			// ハングはこれが原因だった。）
			// そこで **tools があるターンは reasoning を切って（reasoning_effort:"none"）** tools を
			// 確実に通す。reasoning と tools を両立したい場合は openAiUseResponsesApi=true 経路を使う
			// （Responses は両立可）。
			// "none" は SDK 5.12 の ReasoningEffort 型（minimal|low|medium|high|null）に未収録だが、
			// gpt-5.x はサーバ側で受け付ける正規値なので cast して送る。
			// 実験トグル: openAiReasoningWithTools=true なら、tools があっても reasoning を切らずに送る。
			// 旧 400 の真因は read_file の strict:true（0.7.20 で修正済み）で、reasoning+tools 自体は
			// 通る endpoint がある。非対応なら 400/ハングをウォッチドッグ・4xx 終端が安全に表面化する。
			const hasTools = Array.isArray(metadata?.tools) && metadata.tools.length > 0
			if (hasTools && !this.options.openAiReasoningWithTools) {
				return {
					...base,
					reasoning_effort: "none" as unknown as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
				}
			}
			return { ...base, ...reasoning }
		}
		// reasoning でないときのみ temperature を検討。明示設定（number）があれば送る。
		if (typeof this.options.modelTemperature === "number") {
			return { ...base, temperature: this.options.modelTemperature }
		}
		return base
	}

	/**
	 * 実リクエストが永遠にハングしないよう、タイムアウトのウォッチドッグを作る。
	 *
	 * なぜ `Promise.race` か: 以前は AbortController に頼ったが、**OpenAI SDK 経由の
	 * リクエストでは signal が下層 fetch に伝わらず abort が効かない環境があった**
	 * （接続テストは生 fetch なので効くが、実リクエストは SDK 経由で効かず、
	 * apiRequestTimeout を短くしてもハングし続けた）。そこで abort の成否に依存せず、
	 * **拡張側が「待つのをやめて」タイムアウトエラーを必ず表面化する**方式にする。
	 * abort も併用する（下層が対応していれば実際にキャンセルされる。best-effort）。
	 *
	 * `race(p)` は p とタイマーを競わせ、時間切れなら reject する。呼ぶたびに新しい
	 * タイマーを張るので、streaming の各チャンク待ち（`iterator.next()`）に使えば
	 * **チャンク間の無音**にも効く。`requestTimeoutMs` が undefined（設定 0 = 無制限）の
	 * ときは素通し。`clear()` で保留中タイマーを片付ける。
	 */
	protected createRequestWatchdog(): {
		signal: AbortSignal
		race: <T>(p: Promise<T>) => Promise<T>
		clear: () => void
	} {
		const controller = new AbortController()
		const ms = this.requestTimeoutMs
		const timers = new Set<ReturnType<typeof setTimeout>>()
		const race = <T>(p: Promise<T>): Promise<T> => {
			if (ms === undefined) return p
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					timers.delete(timer)
					// 下層が対応していれば実際にキャンセル（best-effort）。
					try {
						controller.abort()
					} catch {
						/* v8 ignore next -- abort は基本投げないが防御 */
					}
					reject(new Error(`request timed out after ${ms}ms`))
				}, ms)
				timers.add(timer)
				p.then(
					(v) => {
						clearTimeout(timer)
						timers.delete(timer)
						resolve(v)
					},
					(e) => {
						clearTimeout(timer)
						timers.delete(timer)
						reject(e)
					},
				)
			})
		}
		return {
			signal: controller.signal,
			race,
			clear: () => {
				for (const t of timers) clearTimeout(t)
				timers.clear()
			},
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: AgentMessage[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { info: modelInfo, reasoning } = this.getModel()
		const modelUrl = this.options.openAiBaseUrl ?? ""
		const modelId = this.options.openAiModelId ?? ""
		const isAzureAiInference = this._isAzureAiInference(modelUrl)
		if (this.options.openAiUseResponsesApi) {
			// GPT-5 系は chat.completions で reasoning + tool を許さない (400)。
			// Responses API に逃がすと両立できるため、UI トグル or CLI フラグで opt-in する。
			yield* this.handleResponsesApiMessage(modelId, systemPrompt, messages, metadata)
			return
		}

		if (modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")) {
			yield* this.handleO3FamilyMessage(modelId, systemPrompt, messages, metadata)
			return
		}

		const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}

		const convertedMessages = [systemMessage, ...this.agentMessagesToChatCompletion(messages)]

		if (this.options.openAiStreamingEnabled ?? true) {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				...this.buildCommonChatParams(modelId, convertedMessages, metadata, reasoning),
				stream: true as const,
				stream_options: { include_usage: true },
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// ハング防止のウォッチドッグ。create（初回応答待ち）と各チャンク待ちを race で包み、
			// 応答が来ない／チャンク間で黙り込むケースを確実にタイムアウトさせる。
			const watchdog = this.createRequestWatchdog()
			try {
				const stream = await watchdog.race(
					this.client.chat.completions.create(requestOptions, {
						...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
						signal: watchdog.signal,
					}),
				)

				const matcher = new TagMatcher(
					"think",
					(chunk) =>
						({
							type: chunk.matched ? "reasoning" : "text",
							text: chunk.data,
						}) as const,
				)

				let lastUsage
				const activeToolCallIds = new Set<string>()

				// 各チャンク待ちを race で包む（`for await` だとチャンク間の無音にタイムアウトを
				// 効かせられないため、手動イテレータで next() ごとに race する）。
				const iterator = stream[Symbol.asyncIterator]()
				while (true) {
					const { value: chunk, done } = await watchdog.race(iterator.next())
					if (done) {
						break
					}
					const delta = chunk.choices?.[0]?.delta ?? {}
					const finishReason = chunk.choices?.[0]?.finish_reason

					if (delta.content) {
						for (const chunk of matcher.update(delta.content)) {
							yield chunk
						}
					}

					const reasoningText = readReasoningText(delta)

					if (reasoningText) {
						yield { type: "reasoning", text: reasoningText }
					}

					yield* this.processToolCalls(delta, finishReason, activeToolCallIds)

					if (chunk.usage) {
						lastUsage = chunk.usage
					}
				}

				for (const chunk of matcher.final()) {
					yield chunk
				}

				if (lastUsage) {
					yield this.processUsageMetrics(lastUsage, modelInfo)
				}
			} catch (error) {
				throw attachSentRequest(handleOpenAIError(error, this.providerName), requestOptions)
			} finally {
				watchdog.clear()
			}
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
				this.buildCommonChatParams(modelId, convertedMessages, metadata, reasoning)

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// ハング防止のウォッチドッグ（非ストリーミングは応答一括なので create を race で包む）。
			const watchdog = this.createRequestWatchdog()
			let response
			try {
				response = await watchdog.race(
					this.client.chat.completions.create(requestOptions, {
						...(this._isAzureAiInference(modelUrl) ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
						signal: watchdog.signal,
					}),
				)
			} catch (error) {
				throw attachSentRequest(handleOpenAIError(error, this.providerName), requestOptions)
			} finally {
				watchdog.clear()
			}

			const message = response.choices?.[0]?.message

			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}

			yield this.processUsageMetrics(response.usage, modelInfo)
		}
	}

	protected processUsageMetrics(usage: any, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheReadTokens: readCachedTokens(usage),
		}
	}

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		const info: ModelInfo = this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults
		const params = getModelParams({
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		return { id, info, ...params }
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let response
			try {
				response = await this.client.chat.completions.create(
					requestOptions,
					isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
				)
			} catch (error) {
				throw attachSentRequest(handleOpenAIError(error, this.providerName), requestOptions)
			}

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`${this.providerName} completion error: ${error.message}`)
			}

			throw error
		}
	}

	private async *handleO3FamilyMessage(
		modelId: string,
		systemPrompt: string,
		messages: AgentMessage[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const modelInfo = this.getModel().info
		const methodIsAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)

		if (this.options.openAiStreamingEnabled ?? true) {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...this.agentMessagesToChatCompletion(messages),
				],
				stream: true,
				stream_options: { include_usage: true },
				reasoning_effort: modelInfo.reasoningEffort as "low" | "medium" | "high" | undefined,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let stream
			try {
				stream = await this.client.chat.completions.create(
					requestOptions,
					methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
				)
			} catch (error) {
				throw attachSentRequest(handleOpenAIError(error, this.providerName), requestOptions)
			}

			yield* this.handleStreamResponse(stream)
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...this.agentMessagesToChatCompletion(messages),
				],
				reasoning_effort: modelInfo.reasoningEffort as "low" | "medium" | "high" | undefined,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let response
			try {
				response = await this.client.chat.completions.create(
					requestOptions,
					methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
				)
			} catch (error) {
				throw attachSentRequest(handleOpenAIError(error, this.providerName), requestOptions)
			}

			const message = response.choices?.[0]?.message
			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}
			yield this.processUsageMetrics(response.usage)
		}
	}

	private async *handleStreamResponse(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): ApiStream {
		const activeToolCallIds = new Set<string>()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			const finishReason = chunk.choices?.[0]?.finish_reason

			if (delta) {
				if (delta.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}

				const reasoningText = readReasoningText(delta)

				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					cacheReadTokens: readCachedTokens(chunk.usage),
				}
			}
		}
	}

	/**
	 * Responses API 経由の送信。
	 *
	 * chat.completions で reasoning + function tools が拒否される
	 * GPT-5 系（GPT-5.6 含む）のための逃げ道。openAiUseResponsesApi=true で opt-in する。
	 *
	 * ここでは streaming + function tools を扱う。reasoning items の
	 * multi-turn 受け渡し（encrypted_content 経由）は後続 PR で対応。
	 */
	private async *handleResponsesApiMessage(
		modelId: string,
		systemPrompt: string,
		messages: AgentMessage[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { info: modelInfo } = this.getModel()
		const streaming = this.options.openAiStreamingEnabled ?? true

		// tool 定義の shape が chat.completions と違う（function ラップが無い）ため詰め直す。
		const chatTools = this.convertToolsForOpenAI(metadata?.tools)
		const responsesTools = chatTools?.map((t: any) => {
			if (t?.type !== "function" || !t?.function) return t
			return {
				type: "function",
				name: t.function.name,
				description: t.function.description,
				parameters: t.function.parameters,
				strict: t.function.strict,
			}
		}) as OpenAI.Responses.Tool[] | undefined

		// reasoning_effort の取り扱い。Chat Completions と違い、Responses は
		// reasoning: { effort } オブジェクトを取る。
		const effort = (modelInfo as { reasoningEffort?: string }).reasoningEffort
		const reasoning =
			this.options.enableReasoningEffort !== false && effort && effort !== "disable"
				? { effort: effort as "minimal" | "low" | "medium" | "high" }
				: undefined

		// 前ターンで受け取った reasoning items をクリアしておく（getEncryptedContent が
		// 直前レスポンスの結果だけを返すため）。
		this.lastResponsesReasoning = undefined

		const params:
			| OpenAI.Responses.ResponseCreateParamsStreaming
			| OpenAI.Responses.ResponseCreateParamsNonStreaming = {
			model: modelId,
			instructions: systemPrompt,
			// AgentMessage[] は既に Responses API の item 型を土台にしているため変換不要。
			// 内部型（拡張独自メタ ts / isSummary 等）を SDK 型として渡すため as で吸収する。
			input: messages as unknown as OpenAI.Responses.ResponseInputItem[],
			stream: streaming as any,
			// reasoning items の multi-turn 受け渡しに必要。stateless（store:false）でも
			// 次のリクエストに encrypted_content を貼り直せば思考の連続性が保てる。
			include: ["reasoning.encrypted_content"] as any,
			...(responsesTools && responsesTools.length > 0
				? {
						tools: responsesTools,
						// parallel tool calls は Responses でも同名 flag が使える
						parallel_tool_calls: metadata?.parallelToolCalls ?? true,
					}
				: {}),
			...(reasoning ? { reasoning } : {}),
		}

		let stream: any
		try {
			stream = await (this.client as OpenAI).responses.create(params as any)
		} catch (error) {
			throw attachSentRequest(handleOpenAIError(error, this.providerName), params)
		}

		if (!streaming) {
			const response = stream as OpenAI.Responses.Response
			// 非ストリーミング応答: output_text と function_call を順にばら撒き、
			// reasoning は getEncryptedContent 経由で保存フックに渡す。
			for (const item of response.output ?? []) {
				if (item.type === "message") {
					for (const part of item.content ?? []) {
						if ("text" in part && part.text) {
							yield { type: "text", text: part.text }
						}
					}
				} else if (item.type === "function_call") {
					yield {
						type: "tool_call",
						id: item.call_id,
						name: item.name,
						arguments: item.arguments,
					}
				} else if (item.type === "reasoning" && (item as any).encrypted_content) {
					this.lastResponsesReasoning = {
						encrypted_content: (item as any).encrypted_content as string,
						id: (item.id as string) || undefined,
					}
				}
			}
			if (response.usage) {
				yield {
					type: "usage",
					inputTokens: response.usage.input_tokens || 0,
					outputTokens: response.usage.output_tokens || 0,
					cacheReadTokens: readCachedTokens(response.usage),
				}
			}
			return
		}

		// ストリーミング: SDK は Stream<ResponseStreamEvent> を返す。
		// 必要イベントだけを拾って ApiStream 形式に変換する。
		//   response.output_text.delta       → text
		//   response.output_item.added(function_call)         → tool_call の開始（名前が確定するのはここ）
		//   response.function_call_arguments.delta            → tool_call_partial（arguments 断片）
		//   response.output_item.done(function_call)          → tool_call の確定
		//   response.completed                                → usage
		// item_id ごとに index を採番して tool_call_partial のシーケンスを構成する。
		const toolCallNames = new Map<string, string>() // item_id -> function name
		const toolCallIds = new Map<string, string>() // item_id -> call_id
		const toolCallIndex = new Map<string, number>() // item_id -> index
		let nextIndex = 0
		for await (const event of stream as AsyncIterable<any>) {
			const type = event?.type as string
			if (type === "response.output_text.delta") {
				if (event.delta) yield { type: "text", text: event.delta }
			} else if (type === "response.output_item.added") {
				const it = event.item
				if (it?.type === "function_call") {
					toolCallNames.set(it.id, it.name)
					toolCallIds.set(it.id, it.call_id)
					toolCallIndex.set(it.id, nextIndex++)
				}
			} else if (type === "response.function_call_arguments.delta") {
				const name = toolCallNames.get(event.item_id)
				const id = toolCallIds.get(event.item_id) ?? event.item_id
				const index = toolCallIndex.get(event.item_id)
				if (name && index !== undefined) {
					yield {
						type: "tool_call_partial",
						index,
						id,
						name,
						arguments: event.delta ?? "",
					}
				}
			} else if (type === "response.output_item.done") {
				const it = event.item
				if (it?.type === "function_call") {
					yield {
						type: "tool_call",
						id: it.call_id,
						name: it.name,
						arguments: it.arguments,
					}
				} else if (it?.type === "reasoning" && it.encrypted_content) {
					// GPT-5 系の暗号化された思考。次リクエストに貼り直すことで
					// multi-turn での思考連続性が保てる。ここでは受信したものを
					// getEncryptedContent() で拾える形に保持しておく。
					// 複数 reasoning items がある場合、後勝ちで最後の 1 個だけを保持する
					// （既存の addToApiConversationHistory の契約が単一の
					// { encrypted_content, id } を想定しているため）。
					this.lastResponsesReasoning = {
						encrypted_content: it.encrypted_content as string,
						id: (it.id as string) || undefined,
					}
				}
			} else if (type === "response.completed") {
				const usage = event.response?.usage
				if (usage) {
					yield {
						type: "usage",
						inputTokens: usage.input_tokens || 0,
						outputTokens: usage.output_tokens || 0,
						cacheReadTokens: readCachedTokens(usage),
					}
				}
			}
		}
	}

	/**
	 * Helper generator to process tool calls from a stream chunk.
	 * Tracks active tool call IDs and yields tool_call_partial and tool_call_end events.
	 * @param delta - The delta object from the stream chunk
	 * @param finishReason - The finish_reason from the stream chunk
	 * @param activeToolCallIds - Set to track active tool call IDs (mutated in place)
	 */
	private *processToolCalls(
		delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
		finishReason: string | null | undefined,
		activeToolCallIds: Set<string>,
	): Generator<
		| { type: "tool_call_partial"; index: number; id?: string; name?: string; arguments?: string }
		| { type: "tool_call_end"; id: string }
	> {
		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (toolCall.id) {
					activeToolCallIds.add(toolCall.id)
				}
				yield {
					type: "tool_call_partial",
					index: toolCall.index,
					id: toolCall.id,
					name: toolCall.function?.name,
					arguments: toolCall.function?.arguments,
				}
			}
		}

		// Emit tool_call_end events when finish_reason is "tool_calls"
		// This ensures tool calls are finalized even if the stream doesn't properly close
		if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
			for (const id of activeToolCallIds) {
				yield { type: "tool_call_end", id }
			}
			activeToolCallIds.clear()
		}
	}

	protected _getUrlHost(baseUrl?: string): string {
		try {
			return new URL(baseUrl ?? "").host
		} catch (_error) {
			return ""
		}
	}

	protected _isAzureAiInference(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.endsWith(".services.ai.azure.com")
	}

	/**
	 * `AgentMessage[]` (Responses item 列) を Chat Completions の `messages` に組み替える。
	 *
	 * かつては `convertToOpenAiMessages` が Anthropic 形式 → Chat Completions の変換を
	 * 担っていたが、内部表現を Responses 形式に統一したことで、Chat Completions 経路
	 * だけがローカルの詰め直しを必要とする（Responses 経路は変換ゼロ）。
	 *
	 * - `type:"message"` (role/content) → そのまま
	 * - `type:"function_call"` → assistant.tool_calls[]
	 * - `type:"function_call_output"` → { role:"tool", tool_call_id, content }
	 * - `type:"reasoning"` → 送らない（Chat Completions では扱えないため）
	 *
	 * assistant の連続する function_call は 1 メッセージに束ねる（Chat Completions の
	 * `tool_calls` は配列）。それ以外の item はそのまま個別メッセージに落とす。
	 */
	protected agentMessagesToChatCompletion(messages: AgentMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
		const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
		let pendingAssistantToolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined
		const flushPendingToolCalls = () => {
			if (pendingAssistantToolCalls && pendingAssistantToolCalls.length > 0) {
				// Responses item 形式では assistant の前置きテキストと function_call が
				// 別 item に分かれるが、Chat Completions の正準形は「1 つの assistant
				// ターン = content + tool_calls」。直前が本文だけの assistant なら
				// そこへ畳み込む。分割すると assistant が 2 連続し、厳格なサーバ
				// (Azure OpenAI 等) が 2 ターン目以降を拒む。
				const last = out[out.length - 1] as OpenAI.Chat.ChatCompletionAssistantMessageParam | undefined
				if (last && last.role === "assistant" && !last.tool_calls) {
					last.tool_calls = pendingAssistantToolCalls
				} else {
					out.push({
						role: "assistant",
						content: "",
						tool_calls: pendingAssistantToolCalls,
					})
				}
			}
			pendingAssistantToolCalls = undefined
		}

		for (const item of messages) {
			switch (item.type) {
				case "message": {
					flushPendingToolCalls()
					const role = item.role
					// developer / system は Chat Completions では両方 system 相当。
					if (role === "developer" || role === "system") {
						const text = typeof item.content === "string" ? item.content : renderPartsAsText(item.content)
						out.push({ role: "system", content: text })
						break
					}
					if (role === "user") {
						out.push({
							role: "user",
							content:
								typeof item.content === "string"
									? item.content
									: renderPartsAsChatContent(item.content),
						})
						break
					}
					// assistant
					out.push({
						role: "assistant",
						content: typeof item.content === "string" ? item.content : renderPartsAsText(item.content),
					})
					break
				}
				case "function_call": {
					if (!pendingAssistantToolCalls) pendingAssistantToolCalls = []
					pendingAssistantToolCalls.push({
						id: item.call_id,
						type: "function",
						function: { name: item.name, arguments: item.arguments },
					})
					break
				}
				case "function_call_output": {
					flushPendingToolCalls()
					out.push({
						role: "tool",
						tool_call_id: item.call_id,
						content: item.output,
					})
					break
				}
				case "reasoning": {
					// Chat Completions API では reasoning items は扱えない。捨てる。
					// GPT-5 系で reasoning を活かしたい場合は openAiUseResponsesApi=true 経路を使うこと。
					break
				}
			}
		}
		flushPendingToolCalls()
		return out
	}

	/**
	 * Adds max_completion_tokens to the request body if needed based on provider configuration
	 * Note: max_tokens is deprecated in favor of max_completion_tokens as per OpenAI documentation
	 * O3 family models handle max_tokens separately in handleO3FamilyMessage
	 */
	protected addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// includeMaxTokens が明示的に true のときだけ送る。
		// かつ maxTokens が**正の有限値**のときだけ（openAiModelInfoSaneDefaults の
		// maxTokens 既定は -1。ガードしないと max_completion_tokens=-1 を送って 400 になる）。
		const maxTokens = modelInfo.maxTokens
		if (this.options.includeMaxTokens === true && typeof maxTokens === "number" && maxTokens > 0) {
			// Using max_completion_tokens as max_tokens is deprecated
			requestOptions.max_completion_tokens = maxTokens
		}
	}
}

export async function getOpenAiModels(
	baseUrl?: string,
	apiKey?: string,
	openAiHeaders?: Record<string, string>,
	proxy?: ProxyOverride,
) {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...(openAiHeaders || {}),
		}
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		// testOpenAiConnection と同じく、企業 proxy を尊重するため
		// undici dispatcher を明示指定した fetch で叩く。axios だと
		// Node の built-in fetch 経路（後段の SDK と同じ）と挙動が食い違う。
		const dispatcher = getProxyDispatcher(proxy)
		const url = `${trimmedBaseUrl.replace(/\/+$/, "")}/models`
		const response = await fetchThrough(dispatcher, url, { method: "GET", headers })
		if (!response.ok) return []
		const data = (await response.json()) as { data?: Array<{ id?: string }> }
		const modelsArray = data?.data?.map((model) => model.id).filter((id): id is string => !!id) || []
		return [...new Set<string>(modelsArray)]
	} catch (_error) {
		return []
	}
}

import { resolveEffectiveProxy, type ProxyResolution } from "../../utils/proxyDispatcher"

/**
 * 接続テストの1プローブ（1 リクエスト）の結果。
 *
 * 接続テストは「① 通常 completion（tools 無し）」と「② tool calling（tools 付き）」の
 * 2 プローブを **同じ transport（グローバル fetch）** で投げて比較する。①が通り②だけ
 * 詰まれば「tool calling が引き金」と一意に切り分けられる（両者の差は tools だけ）。
 * SDK もグローバル fetch を使うため、生 fetch で本番と同じボディ形を投げれば同じ挙動を再現できる。
 */
export interface ConnectionProbeResult {
	/** 人間可読ラベル（例: "② tool calling (tools 有り)"）。 */
	label: string
	/** このプローブで tools を載せたか。 */
	withTools: boolean
	/** 実送信ボディ（機密なし）。 */
	requestBodyPreview: string
	/** 開始〜完了/中断までの ms。 */
	elapsedMs: number
	/** タイムアウト（＝ハング）で中断したか。 */
	timedOut: boolean
	/** HTTP ステータス（応答が来た場合）。 */
	status?: number
	/** 応答 body の先頭プレビュー。 */
	responseBodyPreview?: string
	/** choices を実際に得たか。 */
	modelResponded?: boolean
	/** 例外時の情報。 */
	errorName?: string
	errorMessage?: string
}

/**
 * 接続テストの詳細情報。UI にも Output Channel にも同じ内容が出せるよう、
 * 「機械可読の詳細」と「人間可読の 1 ブロック」の両方を持たせる。
 * 機密情報（API キー、カスタムヘッダの値）は必ずここで伏せてから積む。
 */
export interface ApiConnectionTestDiagnostics {
	requestUrl: string
	requestMethod: "GET" | "POST"
	// ヘッダは名前と値の長さだけ残す。値そのものは載せない。
	requestHeaders: Array<{ name: string; length: number; redactedValue: string }>
	// 実際に送信したリクエストボディ（接続テストの補完 payload）。中身に機密は無い。
	requestBodyPreview?: string
	proxyUrl: string | undefined
	proxyResolvedFrom: ProxyResolution["source"]
	elapsedMs: number
	// HTTP 応答が来た場合
	responseStatus?: number
	responseHeaders?: Array<{ name: string; value: string }>
	responseBodyPreview?: string
	// 例外が起きた場合
	errorName?: string
	errorCode?: string
	errorCauseCode?: string
	errorMessage?: string
	// 成功時: 極小チャット補完が choices を返したか（モデルが実際に応答したか）
	modelResponded?: boolean
	// ② tool calling プローブの結果（①=通常が HTTP 応答を返せた場合のみ実行）。
	// 「①通・②詰まり＝tool calling が引き金」を同じボタン1回で切り分けるため。
	toolCallProbe?: ConnectionProbeResult
	// 人間向け 1 ブロック（改行区切り）。UI 側で <pre> で出すことを想定。
	humanReadable: string
}

/**
 * AgentMessage の content parts を Chat Completions の user content 配列に変換する。
 * text / image のみサポート。
 */
/**
 * usage からキャッシュ読み出しトークン数を拾う。
 *
 * OpenAI は Chat Completions で `prompt_tokens_details.cached_tokens`、Responses で
 * `input_tokens_details.cached_tokens` を返す。以前は Anthropic のフィールド名
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`) を読んでいたため、
 * この値は常に undefined で、キャッシュ会計が働いていなかった。
 *
 * OpenAI に「キャッシュ書き込み」の概念は無い（自動キャッシュ）ため cacheWriteTokens は
 * 扱わない。Anthropic 互換の名前で返す互換サーバのために、その名前も後段で見る。
 */
function readCachedTokens(usage: any): number | undefined {
	const cached =
		usage?.prompt_tokens_details?.cached_tokens ??
		usage?.input_tokens_details?.cached_tokens ??
		usage?.cache_read_input_tokens
	return typeof cached === "number" && cached > 0 ? cached : undefined
}

function renderPartsAsChatContent(
	parts: import("@openai-agent/types").AgentMessageContentPart[],
): OpenAI.Chat.ChatCompletionContentPart[] {
	const out: OpenAI.Chat.ChatCompletionContentPart[] = []
	for (const p of parts) {
		if (p.type === "input_text" || p.type === "output_text") {
			out.push({ type: "text", text: p.text })
		} else if (p.type === "input_image") {
			out.push({ type: "image_url", image_url: { url: p.image_url, detail: p.detail } })
		}
	}
	return out
}

/**
 * AgentMessage の content parts を文字列に平坦化する（assistant/system 用）。
 * image は "[image]" のマーカーだけ残す。
 */
function renderPartsAsText(parts: import("@openai-agent/types").AgentMessageContentPart[]): string {
	const chunks: string[] = []
	for (const p of parts) {
		if (p.type === "input_text" || p.type === "output_text") chunks.push(p.text)
		else if (p.type === "input_image") chunks.push("[image]")
	}
	return chunks.join("\n")
}

export type ApiConnectionTestResult = {
	success: boolean
	message: string
	diagnostics?: ApiConnectionTestDiagnostics
}

const REDACTED_HEADER_NAMES = new Set(["authorization", "api-key", "x-api-key", "openai-organization"])

function redactHeaderValue(name: string, value: string): string {
	const lower = name.toLowerCase()
	if (REDACTED_HEADER_NAMES.has(lower)) {
		// Bearer プレフィックスは残して、実キーは長さだけ晒す。
		if (/^bearer\s+/i.test(value)) {
			const key = value.replace(/^bearer\s+/i, "")
			return `Bearer <${key.length} chars>`
		}
		return `<${value.length} chars>`
	}
	// カスタムヘッダの値も既定で伏せる（何が入っているか読者側で確認できないため）。
	if (value.length <= 8) return `<${value.length} chars>`
	return `${value.slice(0, 2)}…${value.slice(-2)} <${value.length} chars>`
}

function renderHumanReadable(d: ApiConnectionTestDiagnostics): string {
	const lines: string[] = []
	lines.push(`--- 接続テスト診断 (${d.elapsedMs} ms) ---`)
	lines.push(`Request: ${d.requestMethod} ${d.requestUrl}`)
	for (const h of d.requestHeaders) lines.push(`  ${h.name}: ${h.redactedValue}`)
	// testOpenAiConnection は診断構築時に必ず requestBodyPreview を入れる（分岐なし）。
	lines.push(`Request body: ${d.requestBodyPreview}`)
	if (d.proxyUrl) lines.push(`Proxy: ${d.proxyUrl}  (source: ${d.proxyResolvedFrom})`)
	// 「VS Code が解決を握っている」は「何も通していない」とは別物。URL は VS Code 側に
	// あって拡張からは読めないので、(none) と出すと proxy 環境の切り分けを誤らせる。
	else if (d.proxyResolvedFrom === "vscode-managed")
		lines.push(`Proxy: VS Code の解決に委譲 (http.proxySupport)  ← URL は VS Code 側が保持`)
	// 「このモデルは直結」と「そもそも proxy 設定が無い」も別物。全体に proxy を
	// 入れた環境で直結を選んだのか、単に未設定なのかが読めないと切り分けられない。
	else if (d.proxyResolvedFrom === "profile-direct") lines.push(`Proxy: 使用しない（このモデルの設定で直結を指定）`)
	else lines.push(`Proxy: (none)`)
	if (d.responseStatus !== undefined) {
		lines.push(`Response: HTTP ${d.responseStatus}`)
		if (d.responseHeaders) {
			for (const h of d.responseHeaders) lines.push(`  ${h.name}: ${h.value}`)
		}
		if (d.responseBodyPreview !== undefined) {
			lines.push(`Body (先頭 ${d.responseBodyPreview.length} 文字):`)
			lines.push(d.responseBodyPreview)
		}
		if (d.modelResponded !== undefined) {
			lines.push(`Model responded: ${d.modelResponded ? "yes" : "no"}`)
		}
	} else if (d.errorName || d.errorCode || d.errorMessage) {
		lines.push(`Error: ${d.errorName ?? ""} ${d.errorCode ?? ""}`.trim())
		if (d.errorCauseCode) lines.push(`  cause.code: ${d.errorCauseCode}`)
		if (d.errorMessage) lines.push(`  message: ${d.errorMessage}`)
	}
	if (d.toolCallProbe) {
		const p = d.toolCallProbe
		lines.push("")
		lines.push(`--- ${p.label} (${p.elapsedMs} ms) ---`)
		lines.push(`Request body: ${p.requestBodyPreview}`)
		if (p.timedOut) {
			lines.push(`Result: TIMEOUT（${p.elapsedMs} ms で無応答＝ハング）  ← tool calling で詰まっている`)
		} else if (p.status !== undefined) {
			lines.push(`Result: HTTP ${p.status}`)
			if (p.responseBodyPreview !== undefined) {
				lines.push(`  Body (先頭 ${p.responseBodyPreview.length} 文字):`)
				lines.push(p.responseBodyPreview)
			}
			if (p.modelResponded !== undefined) lines.push(`  Model responded: ${p.modelResponded ? "yes" : "no"}`)
		} else if (p.errorName || p.errorMessage) {
			lines.push(`Result: Error ${p.errorName ?? ""}`.trim())
			if (p.errorMessage) lines.push(`  message: ${p.errorMessage}`)
		}
	}
	return lines.join("\n")
}

/**
 * Verifies that the configured OpenAI-compatible endpoint is reachable and usable, returning a
 * human-readable diagnosis + structured diagnostics.
 */
/**
 * tool calling プローブで載せる自明なツール。実挙動には影響しない（tool_choice:"auto"）が、
 * 「tools 付きリクエスト経路」をサーバに踏ませるためだけの最小スキーマ。strict 相当の
 * 制約（additionalProperties:false・required 全指定）も付け、本番のツール定義に近づける。
 */
const CONNECTION_PROBE_TOOL = {
	type: "function" as const,
	function: {
		name: "connectivity_probe",
		description: "A trivial tool used only to exercise the tool-calling request path.",
		parameters: {
			type: "object",
			properties: { ok: { type: "boolean", description: "always true" } },
			required: ["ok"],
			additionalProperties: false,
		},
	},
}

/**
 * 接続テストの1プローブを **生 fetch** で投げて結果を返す（例外は投げず result に畳む）。
 *
 * SDK もグローバル fetch を使うため、生 fetch で本番と同じボディ形（tools 有無）を送れば
 * 同じ transport 挙動を再現できる。応答が返らなければ `timeoutMs` で abort し、`timedOut`
 * を立てる（＝ハングを「無応答」として検出）。テスト用に timeoutMs を短くできるよう引数化。
 */
export async function runConnectionProbe(args: {
	url: string
	headers: Record<string, string>
	dispatcher?: Dispatcher
	model: string
	label: string
	withTools: boolean
	/** undefined は「タイムアウト無し」。ウォッチドッグを張らない。 */
	timeoutMs: number | undefined
}): Promise<ConnectionProbeResult> {
	const { url, headers, dispatcher, model, label, withTools, timeoutMs } = args
	const body = {
		model,
		messages: [{ role: "user", content: "ping" }],
		stream: false,
		...(withTools ? { tools: [CONNECTION_PROBE_TOOL], tool_choice: "auto", parallel_tool_calls: true } : {}),
	}
	const requestBody = JSON.stringify(body)
	const controller = new AbortController()
	let didTimeout = false
	// setTimeout(fn, undefined) は遅延 0 として即発火するので、無制限のときは張らない。
	const timeoutId =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					didTimeout = true
					controller.abort()
				}, timeoutMs)
	const startedAt = Date.now()
	const result: ConnectionProbeResult = {
		label,
		withTools,
		requestBodyPreview: requestBody,
		elapsedMs: 0,
		timedOut: false,
	}
	try {
		const response = await fetchThrough(dispatcher, url, {
			method: "POST",
			headers,
			body: requestBody,
			signal: controller.signal,
		})
		result.status = response.status
		const rawText = await response.text()
		result.responseBodyPreview = rawText.slice(0, 400)
		try {
			const parsed = rawText ? (JSON.parse(rawText) as { choices?: unknown }) : undefined
			result.modelResponded = Array.isArray(parsed?.choices) && (parsed?.choices as unknown[]).length > 0
		} catch {
			// パース失敗しても preview は残る。
		}
	} catch (error) {
		const e = error as { name?: string; message?: string; cause?: { message?: string } }
		result.errorName = e?.name
		result.errorMessage = e?.message || e?.cause?.message
		if (didTimeout || e?.name === "AbortError") result.timedOut = true
	} finally {
		clearTimeout(timeoutId)
		result.elapsedMs = Date.now() - startedAt
	}
	return result
}

export async function testOpenAiConnection(
	baseUrl?: string,
	apiKey?: string,
	openAiHeaders?: Record<string, string>,
	modelId?: string,
	useAzure?: boolean,
	azureApiVersion?: string,
	/** テスト対象プロファイルの proxy 指定。省略時は拡張全体の解決に従う。 */
	proxy?: ProxyOverride,
): Promise<ApiConnectionTestResult> {
	if (!baseUrl || !baseUrl.trim()) {
		return { success: false, message: "Base URL が未設定です。" }
	}
	const trimmedBaseUrl = baseUrl.trim()
	if (!URL.canParse(trimmedBaseUrl)) {
		return { success: false, message: `Base URL の形式が不正です: ${trimmedBaseUrl}` }
	}
	// モデル一覧の取得ではなく、実際に極小のチャット補完を投げて応答を確かめる。
	// /models は Azure だと素直に返らず疎通確認にならないうえ、認証・デプロイ・
	// 本番と同じ chat 経路を検証できない。そのためモデル（Azure ではデプロイ名）が必須。
	if (!modelId || !modelId.trim()) {
		return { success: false, message: "モデルを入力してからテストしてください。" }
	}
	const model = modelId.trim()

	// Azure OpenAI は deployments パス + api-key ヘッダ + api-version クエリ。
	// 素の OpenAI 互換は /chat/completions + Authorization: Bearer。
	// SDK と同じ URL の組み方に合わせる（base は利用者が /openai まで含める前提）。
	// URL.canParse を上で通しているので new URL は投げない。
	const host = new URL(trimmedBaseUrl).host.toLowerCase()
	const isAzure = useAzure === true || host === "azure.com" || host.endsWith(".azure.com")

	const headers: Record<string, string> = {
		...DEFAULT_HEADERS,
		...(openAiHeaders || {}),
		"content-type": "application/json",
	}
	if (apiKey) {
		if (isAzure) headers["api-key"] = apiKey
		else headers["Authorization"] = `Bearer ${apiKey}`
	}

	const base = trimmedBaseUrl.replace(/\/+$/, "")
	const url = isAzure
		? `${base}/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${azureApiVersion || azureOpenAiDefaultApiVersion}`
		: `${base}/chat/completions`

	const dispatcher = getProxyDispatcher(proxy)
	// 実通信と同じ解決を使う。別々に引くと診断が実態とズレる。
	const { url: proxyUrl, source: proxySource } = resolveEffectiveProxy(proxy)
	const controller = new AbortController()
	// 本番リクエストと同じ上限（`openai-agent.apiRequestTimeout`）を使う。接続テストだけ
	// 固定 15 秒だと、応答の遅いローカルモデル（大きな system prompt のプレフィルで初回
	// チャンクまで数分かかる）を「繋がらない」と誤判定する。
	//
	// undefined は「タイムアウト無し」の意味なので、ウォッチドッグ自体を張らない。
	// setTimeout(fn, undefined) は遅延 0 として即発火するため、そのまま渡すと
	// 無制限を選んだ利用者の接続テストが必ず即死する。
	const connectionTimeoutMs = getApiRequestTimeout()
	const timeoutId =
		connectionTimeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), connectionTimeoutMs)
	const startedAt = Date.now()

	// 実際に投げるボディ。診断にもそのまま載せて「何を送ったか」を見えるようにする。
	// 「送信内容が分からず切り分けに苦労した」を繰り返さないため。中身に機密は無い。
	const requestBody = JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream: false })

	const diagnostics: ApiConnectionTestDiagnostics = {
		requestUrl: url,
		requestMethod: "POST",
		requestHeaders: Object.entries(headers).map(([name, value]) => ({
			name,
			length: value.length,
			redactedValue: redactHeaderValue(name, value),
		})),
		requestBodyPreview: requestBody,
		proxyUrl,
		proxyResolvedFrom: proxySource,
		elapsedMs: 0,
		humanReadable: "",
	}

	try {
		const response = await fetchThrough(dispatcher, url, {
			method: "POST",
			headers,
			body: requestBody,
			signal: controller.signal,
		})
		clearTimeout(timeoutId)
		diagnostics.elapsedMs = Date.now() - startedAt
		diagnostics.responseStatus = response.status

		// レスポンスヘッダのうち、切り分けに使うものを残す。全部は載せない（Set-Cookie 等混入回避）。
		const kept = ["content-type", "content-length", "x-request-id", "x-ratelimit-remaining-requests"]
		diagnostics.responseHeaders = kept
			.map((n) => ({ name: n, value: response.headers.get(n) ?? "" }))
			.filter((h) => h.value)

		const rawText = await response.text()
		diagnostics.responseBodyPreview = rawText.slice(0, 400)

		let hasChoices = false
		try {
			const parsed = rawText ? (JSON.parse(rawText) as { choices?: unknown }) : undefined
			hasChoices = Array.isArray(parsed?.choices) && (parsed?.choices as unknown[]).length > 0
		} catch {
			// パース失敗しても preview は残る。切り分けに使える。
		}
		if (response.ok) {
			diagnostics.modelResponded = hasChoices
		}

		if (!response.ok) {
			let message: string
			if (response.status === 401 || response.status === 403) {
				message = `認証エラー（HTTP ${response.status}）。API キー / 権限 / カスタムヘッダを確認してください。`
			} else if (response.status === 404) {
				message = isAzure
					? `エンドポイント/デプロイが見つかりません（HTTP 404）。Base URL に /openai が含まれるか、デプロイ名（モデル）と api-version を確認してください。`
					: `エンドポイントが見つかりません（HTTP 404）。Base URL に /v1 等のパスが必要か、モデル名を確認してください。`
			} else {
				message = `サーバーがエラーを返しました（HTTP ${response.status}）。`
			}
			diagnostics.humanReadable = renderHumanReadable(diagnostics)
			return { success: false, message, diagnostics }
		}

		// ② tool calling プローブ: ①（通常）が HTTP 2xx を返せたので、同じ transport で
		// tools 付きの実リクエスト形を投げる。①との差は tools だけなので、②だけ詰まれば
		// 「tool calling が引き金」と一意に切り分けられる。stream:false で tools 単独の
		// 影響を見る。上限は①と同じ `openai-agent.apiRequestTimeout`——tools 有りは体感でも
		// 遅いが、①が本番と同じ上限を持つ以上ここだけ短くする理由が無い。
		const toolCallProbe = await runConnectionProbe({
			url,
			headers,
			dispatcher,
			model,
			label: "② tool calling (tools 有り)",
			withTools: true,
			timeoutMs: connectionTimeoutMs,
		})
		diagnostics.toolCallProbe = toolCallProbe

		diagnostics.humanReadable = renderHumanReadable(diagnostics)
		if (toolCallProbe.timedOut) {
			return {
				success: false,
				message:
					"通常リクエストは成功しましたが、tool calling でタイムアウト（無応答ハング）しました。" +
					"tools 付きリクエストが endpoint/proxy で詰まっています。",
				diagnostics,
			}
		}
		if (toolCallProbe.status !== undefined && toolCallProbe.status >= 400) {
			return {
				success: false,
				message: `通常リクエストは成功しましたが、tool calling が HTTP ${toolCallProbe.status} を返しました。tools のスキーマ/対応状況を確認してください。`,
				diagnostics,
			}
		}
		if (toolCallProbe.errorName || toolCallProbe.errorMessage) {
			return {
				success: false,
				message: `通常リクエストは成功しましたが、tool calling でエラーが発生しました: ${toolCallProbe.errorMessage ?? toolCallProbe.errorName}`,
				diagnostics,
			}
		}
		return {
			success: true,
			message: hasChoices
				? "接続成功。通常・tool calling とも応答しました。"
				: "接続成功（通常・tool calling とも受信。ただし choices が空でした）。",
			diagnostics,
		}
	} catch (error: unknown) {
		clearTimeout(timeoutId)
		diagnostics.elapsedMs = Date.now() - startedAt
		const classified = classifyConnectionError(error)
		const err = error as {
			name?: string
			code?: string
			message?: string
			cause?: { code?: string; message?: string }
		}
		diagnostics.errorName = err?.name
		diagnostics.errorCode = err?.code
		diagnostics.errorCauseCode = err?.cause?.code
		diagnostics.errorMessage = err?.message || err?.cause?.message
		diagnostics.humanReadable = renderHumanReadable(diagnostics)
		return { ...classified, diagnostics }
	}
}

function classifyConnectionError(error: unknown): { success: false; message: string } {
	const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } }
	if (err?.name === "AbortError") {
		return { success: false, message: `タイムアウトしました。到達性やプロキシ設定を確認してください。` }
	}
	const code: string = err?.code || err?.cause?.code || ""
	const msg: string = err?.message || err?.cause?.message || String(error)

	const tlsCodes = [
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"CERT_HAS_EXPIRED",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	]
	if (tlsCodes.includes(code)) {
		return { success: false, message: `SSL/証明書エラー（${code}）。証明書または CA 設定を確認してください。` }
	}
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return {
			success: false,
			message: `宛先ホストが見つかりません（DNS 解決失敗）。Base URL のホスト名を確認してください。`,
		}
	}
	if (code === "ECONNREFUSED") {
		return {
			success: false,
			message: `接続を拒否されました（ECONNREFUSED）。ホスト/ポート/到達性を確認してください。`,
		}
	}
	if (code === "ETIMEDOUT" || /timeout/i.test(msg)) {
		return { success: false, message: `タイムアウトしました。到達性やプロキシ設定を確認してください。` }
	}
	if (/proxy/i.test(msg)) {
		return { success: false, message: `プロキシ経由の接続に失敗しました: ${msg}` }
	}
	return { success: false, message: `接続に失敗しました: ${msg}` }
}
