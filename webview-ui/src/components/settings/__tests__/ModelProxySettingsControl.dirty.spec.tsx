// 「Proxy の値を入力したら変更として検知され、保存対象に載るか」を、
// SettingsView.setApiConfigurationField と同じ経路（shouldMarkDirty 込み）で検証する。
import { useState, useCallback } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import type { ProviderSettings } from "@openai-agent/types"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (k: string) => k }),
}))

// VSCodeTextField は web component で value セッターを持たず、fireEvent が値を差し込めない。
// 他の settings spec と同じくネイティブ input に落とす（onInput / e.target.value の
// 受け渡しは実装と同じ形のまま検証できる）。
vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				data-testid={testId}
			/>
			{children}
		</label>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, disabled, "data-testid": testId }: any) => (
		<div>
			{children}
			<input value={value} onChange={onInput} disabled={disabled} data-testid={testId} />
		</div>
	),
}))

import { ModelProxySettingsControl } from "@src/components/settings/ModelProxySettingsControl"
import { shouldMarkDirty } from "@src/components/settings/settingsChangeDetection"

/** SettingsView.tsx:234-248 と同じ実装。 */
const Harness = ({ initial, onState }: { initial: ProviderSettings; onState: (s: any) => void }) => {
	const [config, setConfig] = useState<ProviderSettings>(initial)
	const [changeDetected, setChangeDetected] = useState(false)

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			setConfig((prev) => {
				if (prev?.[field] === value) return prev
				if (shouldMarkDirty(field as string, prev?.[field], value, isUserAction)) setChangeDetected(true)
				return { ...prev, [field]: value }
			})
		},
		[],
	)

	onState({ config, changeDetected })
	return <ModelProxySettingsControl apiConfiguration={config} setApiConfigurationField={setApiConfigurationField} />
}

describe("Proxy の入力が変更として検知され保存対象に載るか", () => {
	it("URL を入力すると changeDetected が立ち、値が config に入る", () => {
		let latest: any
		render(<Harness initial={{ openAiProxyMode: "custom" } as ProviderSettings} onState={(s) => (latest = s)} />)

		expect(latest.changeDetected).toBe(false)

		fireEvent.change(screen.getByTestId("model-proxy-url-input"), {
			target: { value: "socks5://127.0.0.1:1080" },
		})

		expect(latest.config.openAiProxyUrl).toBe("socks5://127.0.0.1:1080")
		expect(latest.changeDetected).toBe(true)
	})

	it("未設定から URL を入れた場合も変更として数える（初期同期と混同しない）", () => {
		let latest: any
		render(<Harness initial={{ openAiProxyMode: "custom" } as ProviderSettings} onState={(s) => (latest = s)} />)

		fireEvent.change(screen.getByTestId("model-proxy-url-input"), { target: { value: "http://p:3128" } })

		expect(latest.changeDetected).toBe(true)
	})
})
