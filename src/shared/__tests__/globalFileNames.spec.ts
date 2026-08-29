// npx vitest run shared/__tests__/globalFileNames.spec.ts

import { GlobalFileNames } from "../globalFileNames"

describe("GlobalFileNames", () => {
	it("既知のファイル名を公開する", () => {
		expect(GlobalFileNames.apiConversationHistory).toBe("api_conversation_history.json")
		expect(GlobalFileNames.uiMessages).toBe("ui_messages.json")
		expect(GlobalFileNames.mcpSettings).toBe("mcp_settings.json")
		expect(GlobalFileNames.taskMetadata).toBe("task_metadata.json")
		expect(GlobalFileNames.historyItem).toBe("history_item.json")
		expect(GlobalFileNames.historyIndex).toBe("_index.json")
	})
})
