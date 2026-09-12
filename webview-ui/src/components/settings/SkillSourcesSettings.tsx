import { useCallback, useMemo } from "react"
import { Plus, Trash2, Download, KeyRound } from "lucide-react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { OpenAiProxyMode, SkillSource } from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Button, StandardTooltip } from "@/components/ui"
import { vscode } from "@/utils/vscode"

import { ProxySettingsControl } from "./ProxySettingsControl"

type SkillSourcesSettingsProps = {
	skillSources: SkillSource[] | undefined
	setSkillSources: (sources: SkillSource[]) => void
}

/** URL から経路を見分ける。SSH なら proxy が効かない（`FR-EXT-05b3` `FR-UI-29a`）。 */
export function isSshUrl(url: string): boolean {
	const trimmed = url.trim()
	if (/^https?:\/\//i.test(trimmed)) return false
	return /^ssh:\/\//i.test(trimmed) || /^(?:[^@/]+@)?[^@/:]+:.+$/.test(trimmed)
}

/**
 * スキルの取得元を編集する（`FR-UI-29`）。
 *
 * 一覧そのものは設定なので、保存の操作まで反映しない（`NFR-USA-06`）。取得は操作なので、
 * 押した行の値をそのまま送る。保存の前でも試せる。
 */
export const SkillSourcesSettings = ({ skillSources, setSkillSources }: SkillSourcesSettingsProps) => {
	const { t } = useAppTranslation()
	// useCallback の依存に入るので、毎回の描画で別物にならないようにする。
	const sources = useMemo(() => skillSources ?? [], [skillSources])

	const update = useCallback(
		(index: number, patch: Partial<SkillSource>) => {
			setSkillSources(sources.map((source, i) => (i === index ? { ...source, ...patch } : source)))
		},
		[sources, setSkillSources],
	)

	const add = useCallback(() => setSkillSources([...sources, { url: "" }]), [sources, setSkillSources])

	const remove = useCallback(
		(index: number) => setSkillSources(sources.filter((_, i) => i !== index)),
		[sources, setSkillSources],
	)

	const fetch = useCallback((source: SkillSource) => {
		vscode.postMessage({ type: "fetchSkillSource", values: { ...source } })
	}, [])

	// 資格情報は URL だけ送って、値は拡張ホスト側で聞く（`FR-EXT-06b`）。
	// webview を経由すると、渡す経路が 1 つ増える。
	const askCredentials = useCallback((url: string) => {
		vscode.postMessage({ type: "saveSkillSourceCredentials", values: { url } })
	}, [])

	return (
		<div className="flex flex-col gap-3">
			<div className="flex justify-between items-center">
				<label className="block font-medium">{t("settings:skills.sources.title")}</label>
				<StandardTooltip content={t("settings:skills.sources.add")}>
					<Button variant="secondary" className="py-1" onClick={add} data-testid="skill-source-add">
						<Plus />
					</Button>
				</StandardTooltip>
			</div>

			<div className="text-sm text-vscode-descriptionForeground">{t("settings:skills.sources.description")}</div>

			{sources.length === 0 ? (
				<div className="text-sm text-vscode-descriptionForeground">{t("settings:skills.sources.none")}</div>
			) : (
				sources.map((source, index) => {
					const ssh = isSshUrl(source.url)

					return (
						<div key={index} className="flex flex-col gap-2 border border-vscode-panel-border p-2">
							<div className="flex items-center gap-2">
								<VSCodeTextField
									value={source.url}
									className="flex-1"
									placeholder="https://gitlab.example.com/platform/skills.git"
									data-testid={`skill-source-url-${index}`}
									onInput={(event: unknown) =>
										update(index, {
											url: (event as { target: { value: string } }).target.value,
										})
									}
								/>
								<StandardTooltip content={t("settings:skills.sources.fetch")}>
									<Button
										variant="secondary"
										className="py-1"
										onClick={() => fetch(source)}
										data-testid={`skill-source-fetch-${index}`}>
										<Download />
									</Button>
								</StandardTooltip>
								{ssh ? null : (
									<StandardTooltip content={t("settings:skills.sources.credentials")}>
										<Button
											variant="secondary"
											className="py-1"
											onClick={() => askCredentials(source.url)}
											data-testid={`skill-source-credentials-${index}`}>
											<KeyRound />
										</Button>
									</StandardTooltip>
								)}
								<StandardTooltip content={t("settings:skills.sources.remove")}>
									<Button
										variant="secondary"
										className="py-1"
										onClick={() => remove(index)}
										data-testid={`skill-source-remove-${index}`}>
										<Trash2 />
									</Button>
								</StandardTooltip>
							</div>

							{ssh ? (
								<div
									className="text-sm text-vscode-descriptionForeground"
									data-testid={`skill-source-ssh-note-${index}`}>
									{t("settings:skills.sources.sshIgnoresProxy")}
								</div>
							) : null}

							<Checkbox
								checked={source.copyToShared === true}
								onChange={(checked: boolean) => update(index, { copyToShared: checked })}
								data-testid={`skill-source-copy-${index}`}>
								{t("settings:skills.sources.copyToShared")}
							</Checkbox>
							<div className="text-sm text-vscode-descriptionForeground ml-6">
								{t("settings:skills.sources.copyToSharedDescription")}
							</div>

							<ProxySettingsControl
								mode={source.proxyMode}
								url={source.proxyUrl}
								disabled={ssh}
								testIdPrefix={`skill-source-proxy-${index}`}
								onChange={({ mode, url }: { mode: OpenAiProxyMode; url: string }) =>
									update(index, { proxyMode: mode, proxyUrl: url })
								}
								labels={{
									enable: t("settings:proxy.model.enable"),
									description: t("settings:skills.sources.proxyDescription"),
									urlLabel: t("settings:proxy.model.urlLabel"),
									blankIsDirect: t("settings:proxy.model.blankIsDirect"),
								}}
							/>
						</div>
					)
				})
			)}
		</div>
	)
}
