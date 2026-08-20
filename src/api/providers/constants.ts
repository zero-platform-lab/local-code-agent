import { Package } from "../../shared/package"

// HTTP-Referer / X-Title は OpenRouter 専用の attribution ヘッダで、この fork には
// OpenRouter プロバイダが無い。全 OpenAI 互換エンドポイント（Azure 含む）に常時
// 送るのは無意味なので送らない。
export const DEFAULT_HEADERS = {
	"User-Agent": `OpenAIAgent/${Package.version}`,
}
