import type { ContentBlockParam } from "@openai-agent/types"
import workerpool from "workerpool"

import { tiktoken } from "../utils/tiktoken"

import { type CountTokensResult } from "./types"

async function countTokens(content: ContentBlockParam[]): Promise<CountTokensResult> {
	try {
		const count = await tiktoken(content)
		return { success: true, count }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		}
	}
}

workerpool.worker({ countTokens })
