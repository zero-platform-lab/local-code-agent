// Standalone security-only lint (eslint-plugin-security).
// Kept separate from the strict build lint so security findings surface as a report
// without blocking the normal `pnpm lint`. Run with: `pnpm lint:security`.
import security from "eslint-plugin-security"
import tsParser from "@typescript-eslint/parser"

export default [
	{
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/build/**",
			"**/out/**",
			"**/.next/**",
			"**/.turbo/**",
			"**/*.d.ts",
			"**/__tests__/**",
			"**/__mocks__/**",
			"**/*.test.ts",
			"**/*.spec.ts",
			"**/*.test.tsx",
			"**/*.spec.tsx",
		],
	},
	{
		files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: { jsx: true },
			},
		},
		plugins: { security },
		rules: security.configs.recommended.rules,
	},
]
