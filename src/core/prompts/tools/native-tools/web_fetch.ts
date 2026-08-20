import type OpenAI from "openai"

const WEB_FETCH_DESCRIPTION = `Fetch the contents of an http(s) URL and return it as text. Use this to read a web page or an online document when you have a specific URL. HTML pages are converted to readable text. Very long pages may be truncated (raise max_length if needed).

Parameters:
- url: (required) The absolute http(s) URL to fetch (e.g. "https://example.com/docs").
- max_length: (optional) Maximum number of characters of content to return (default 50000).

Example:
{ "url": "https://example.com/page" }`

// strict は付けない（非 strict 方針。convertToolsForOpenAI で全ツールから剥がす）。
export default {
	type: "function",
	function: {
		name: "web_fetch",
		description: WEB_FETCH_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The absolute http(s) URL to fetch.",
				},
				max_length: {
					type: "number",
					description: "Maximum number of characters of content to return (default 50000).",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
