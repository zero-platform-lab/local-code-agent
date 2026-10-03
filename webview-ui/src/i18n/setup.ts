import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// Dynamically load locale files
const localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json/)

	/* v8 ignore else -- 到達不能: import.meta.glob はビルド時に展開され、現在の locales は <言語>/<名前空間>.json の 2 階層だけなので必ず一致する。階層の深いファイルへの防御は残す */
	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		/* v8 ignore next -- 到達不能: import.meta.glob(eager) が返す JSON モジュールは常に default を持つため右辺は踏めない。素のモジュール形式への防御は残す */
		translations[language][namespace] = (module as any).default || module
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
i18next.use(initReactI18next).init({
	lng: "ja",
	fallbackLng: "ja",
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export function loadTranslations() {
	Object.entries(translations).forEach(([lang, namespaces]) => {
		try {
			Object.entries(namespaces).forEach(([namespace, resources]) => {
				i18next.addResourceBundle(lang, namespace, resources, true, true)
			})
		} catch (error) {
			console.warn(`Could not load ${lang} translations:`, error)
		}
	})
}

export default i18next
