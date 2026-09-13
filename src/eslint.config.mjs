import { config } from "@openai-agent/config-eslint/base"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		rules: {
			// no-explicit-any は 1,942 件残っており型付け改善という別種の作業のため据え置き。
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	{
		files: ["core/assistant-message/presentAssistantMessage.ts", "core/webview/webviewMessageHandler.ts"],
		rules: {
			"no-case-declarations": "off",
		},
	},
	{
		// CommonJS として書く。束ねる側が読み込むだけで、拡張の本体からは参照しない。
		files: ["__mocks__/**/*.js", "build-stubs/**/*.js"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		ignores: ["webview-ui", "out"],
	},
]
