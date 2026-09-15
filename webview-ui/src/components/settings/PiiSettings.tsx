import { useCallback, useMemo, useState } from "react"
import { useEvent, useMount } from "react-use"
import { Shield, Plus, Trash2, FileText, Download } from "lucide-react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	nerEntities,
	piiKinds,
	type ExtensionMessage,
	type NerEntity,
	type PiiKind,
	type PiiMasking,
} from "@openai-agent/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Button, StandardTooltip } from "@/components/ui"
import { vscode } from "@/utils/vscode"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"

type PiiSettingsProps = {
	piiMasking: PiiMasking | undefined
	setPiiMasking: (value: PiiMasking) => void
}

/**
 * 機密情報の伏せ字の設定。
 *
 * **目的。** 伏せ字に関わる設定を 1 か所に置く。シークレットモードの切り替え
 * （`FR-PII-01`）、伏せる種類の選択（`FR-PII-07`）、辞書のファイルの管理
 * （`FR-PII-16`）、辞書の書き出し（`FR-PII-17`）である。
 *
 * **仕組み。** 一覧と切り替えは設定なので、保存の操作まで反映しない（`NFR-USA-06`）。
 * 書き出しと「開く」は操作なので、押した時点で拡張ホストへ送る。
 *
 * **語を 1 つずつ並べる表は置かない。** 語が増えると設定の画面が使いものにならない。
 * 語は辞書のファイル側で扱い、追加はエディタの右クリックから行う。
 *
 * **種類を 1 つも選んでいない状態は作れる。** その場合は 1 件も伏せられないので、その旨を
 * 出す。切り替えが有効なまま「伏せているつもり」になるのを防ぐ。
 */
export const PiiSettings = ({ piiMasking, setPiiMasking }: PiiSettingsProps) => {
	const { t } = useAppTranslation()

	// useCallback の依存に入るので、毎回の描画で別物にならないようにする。
	const masking = useMemo(() => piiMasking ?? {}, [piiMasking])
	// 未指定は「全部の種類を伏せる」。設定を触らなくても既定の動きが決まる。
	const kinds = useMemo(() => masking.kinds ?? [...piiKinds], [masking.kinds])
	const paths = masking.dictionaryPaths ?? []

	const update = useCallback(
		(patch: Partial<PiiMasking>) => setPiiMasking({ ...masking, ...patch }),
		[masking, setPiiMasking],
	)

	const toggleKind = useCallback(
		(kind: PiiKind, checked: boolean) =>
			update({ kinds: checked ? [...kinds, kind] : kinds.filter((one) => one !== kind) }),
		[kinds, update],
	)

	const properNouns = useMemo(() => masking.properNouns ?? {}, [masking.properNouns])

	/**
	 * モデルの置き場所の様子。
	 *
	 * **どこを見ているかを画面へ出すために持つ。** 出さないと、閉鎖環境の利用者は
	 * どこへファイルを運べばよいか分からない。欄が空なら既定の場所を見るが、その場所は
	 * 画面のどこにも書いていなかった。
	 */
	const [model, setModel] = useState<ExtensionMessage["piiNerModel"]>()

	const askModel = useCallback(
		(path?: string) => vscode.postMessage({ type: "requestPiiNerModelStatus", text: path ?? "" }),
		[],
	)

	useEvent(
		"message",
		useCallback((event: MessageEvent) => {
			const message = event.data as ExtensionMessage
			if (message.type === "piiNerModelStatus") setModel(message.piiNerModel)
		}, []),
	)

	useMount(() => askModel(properNouns.modelPath))
	// 未指定は「製品名とイベント名だけ伏せない」（`FR-PII-21b`）。React が伏せ字になると、
	// モデルは何の話か判断できなくなる。
	const entities = useMemo(
		() => properNouns.entities ?? nerEntities.filter((one) => one !== "PRD" && one !== "EVT"),
		[properNouns.entities],
	)

	const updateProperNouns = useCallback(
		(patch: Partial<NonNullable<PiiMasking["properNouns"]>>) =>
			update({ properNouns: { ...properNouns, ...patch } }),
		[properNouns, update],
	)

	const toggleEntity = useCallback(
		(entity: NerEntity, checked: boolean) =>
			updateProperNouns({
				entities: checked ? [...entities, entity] : entities.filter((one) => one !== entity),
			}),
		[entities, updateProperNouns],
	)

	return (
		<div>
			<SectionHeader>
				<div className="flex items-center gap-2">
					<Shield className="w-4" />
					<div>{t("settings:pii.title")}</div>
				</div>
			</SectionHeader>

			<Section>
				<div className="flex flex-col gap-3">
					<div className="text-sm text-vscode-descriptionForeground">{t("settings:pii.description")}</div>
					{/*
					 * **入切はここに置かない。** 会話の画面のボタンが持つ（`FR-PII-01b`）。
					 * 2 か所から同じ値を書くと、保存の操作が会話の画面での切り替えを
					 * 巻き戻し、伏せたつもりで送ってしまう。
					 */}
					<div className="text-sm text-vscode-descriptionForeground" data-testid="pii-enabled-state">
						{masking.enabled === true ? t("settings:pii.stateOn") : t("settings:pii.stateOff")}
					</div>

					<label className="block font-medium mt-2">{t("settings:pii.kinds")}</label>
					<div className="grid grid-cols-2 gap-1">
						{piiKinds.map((kind) => (
							<Checkbox
								key={kind}
								checked={kinds.includes(kind)}
								onChange={(checked: boolean) => toggleKind(kind, checked)}
								data-testid={`pii-kind-${kind}`}>
								{t(`settings:pii.kind.${kind}`)}
							</Checkbox>
						))}
					</div>
					{kinds.length === 0 ? (
						<div className="text-sm text-vscode-errorForeground" data-testid="pii-no-kinds">
							{t("settings:pii.noKinds")}
						</div>
					) : null}

					<div className="flex justify-between items-center mt-2">
						<label className="block font-medium">{t("settings:pii.dictionaries")}</label>
						<div className="flex gap-1">
							<StandardTooltip content={t("settings:pii.export")}>
								<Button
									variant="secondary"
									className="py-1"
									// **保存前の値を渡す。** 渡さないと、拡張は保存済みの設定を読む。足したばかりの
									// 辞書が書き出しに入らず、利用者には成功したように見える。
									onClick={() =>
										vscode.postMessage({
											type: "exportPiiDictionary",
											values: { terms: masking.terms, dictionaryPaths: paths },
										})
									}
									data-testid="pii-export">
									<Download />
								</Button>
							</StandardTooltip>
							<StandardTooltip content={t("settings:pii.addDictionary")}>
								<Button
									variant="secondary"
									className="py-1"
									onClick={() => update({ dictionaryPaths: [...paths, ""] })}
									data-testid="pii-dictionary-add">
									<Plus />
								</Button>
							</StandardTooltip>
						</div>
					</div>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:pii.dictionariesDescription")}
					</div>

					{paths.length === 0 ? (
						<div className="text-sm text-vscode-descriptionForeground">
							{t("settings:pii.noDictionary")}
						</div>
					) : (
						paths.map((one, index) => (
							<div key={index} className="flex items-center gap-2">
								<VSCodeTextField
									value={one}
									className="flex-1"
									placeholder="~/.agent/pii-dictionary.txt"
									data-testid={`pii-dictionary-${index}`}
									onInput={(event: unknown) =>
										update({
											dictionaryPaths: paths.map((value, i) =>
												i === index
													? (event as { target: { value: string } }).target.value
													: value,
											),
										})
									}
								/>
								<StandardTooltip content={t("settings:pii.openDictionary")}>
									<Button
										variant="secondary"
										className="py-1"
										// 無ければ作って開く。書き方はファイルの先頭に書いてある。
										// `~` は拡張ホスト側で展開する。webview は生の文字列しか
										// 持たないので、ここでは解決しない。
										onClick={() => vscode.postMessage({ type: "openPiiDictionary", text: one })}
										data-testid={`pii-dictionary-open-${index}`}>
										<FileText />
									</Button>
								</StandardTooltip>
								<StandardTooltip content={t("settings:pii.removeDictionary")}>
									<Button
										variant="secondary"
										className="py-1"
										onClick={() => update({ dictionaryPaths: paths.filter((_, i) => i !== index) })}
										data-testid={`pii-dictionary-remove-${index}`}>
										<Trash2 />
									</Button>
								</StandardTooltip>
							</div>
						))
					)}
				</div>

				{/*
				 * 第 2 層（`FR-PII-21`）。辞書に無い固有名詞を、前後の文から判定して伏せる。
				 *
				 * **第 1 層とは別の切り替えを持つ。** モデルのファイルを別に置く必要があり、
				 * 置いていない利用者のほうが多い。第 1 層と同じ切り替えにすると、
				 * 入れたつもりで動かない状態になる。
				 */}
				<div className="flex flex-col gap-2 mt-4 pt-4 border-t border-vscode-panel-border">
					<label className="block font-medium">{t("settings:pii.properNouns.title")}</label>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:pii.properNouns.description")}
					</div>

					{/*
					 * **動かせない配布物では、切り替えを出さない。**
					 *
					 * 配布物は platform ごとに分かれ、`universal` 版には native が入っていない。
					 * 切り替えだけ出すと、入れても何も起きない。画面に変化が無いので、利用者は
					 * 設定が壊れていると思う。実際にそう報告を受けた。
					 */}
					{model && !model.runtime ? (
						<div className="text-sm text-vscode-errorForeground" data-testid="pii-no-runtime">
							{t("settings:pii.properNouns.noRuntime")}
						</div>
					) : (
						<Checkbox
							checked={properNouns.enabled === true}
							onChange={(checked: boolean) => updateProperNouns({ enabled: checked })}
							data-testid="pii-proper-nouns-enabled">
							{t("settings:pii.properNouns.enable")}
						</Checkbox>
					)}

					{model && !model.runtime ? null : (
						<>
							<label className="block mt-2">{t("settings:pii.properNouns.entities")}</label>
							<div className="grid grid-cols-2 gap-1">
								{nerEntities.map((entity) => (
									<Checkbox
										key={entity}
										checked={entities.includes(entity)}
										onChange={(checked: boolean) => toggleEntity(entity, checked)}
										data-testid={`pii-entity-${entity}`}>
										{t(`settings:pii.properNouns.entity.${entity}`)}
									</Checkbox>
								))}
							</div>

							{entities.length === 0 ? (
								<div className="text-sm text-vscode-errorForeground" data-testid="pii-no-entities">
									{t("settings:pii.properNouns.noEntities")}
								</div>
							) : null}

							{/*
							 * **判定にかけてよい時間（`FR-PII-23f`）。** 既定の 10 秒では
							 * 足りない使い方がある。切られたことは警告で出るが、設定が無いと
							 * 利用者にできることが無かった。
							 */}
							<label className="block mt-2">{t("settings:pii.properNouns.timeBudget")}</label>
							<VSCodeTextField
								className="w-full"
								value={String(properNouns.timeBudgetMs ?? 10000)}
								data-testid="pii-time-budget"
								onInput={(event: unknown) => {
									const value =
										typeof event === "object" && event !== null && "target" in event
											? (event as { target: { value: string } }).target.value
											: ""
									// **数でないものは捨てる。** 途中まで書いた値で設定を壊さない。
									// 空欄も捨てる。捨てないと `NaN` が保存され、既定にも
									// 戻らないまま第 2 層が毎回すぐ切られる。
									const ms = Number(value)
									if (value.trim() === "" || !Number.isFinite(ms) || ms < 0) return
									updateProperNouns({ timeBudgetMs: ms })
								}}
							/>
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:pii.properNouns.timeBudgetHelp")}
							</div>

							<label className="block mt-2">{t("settings:pii.properNouns.modelPath")}</label>
							<div className="flex gap-1 items-center">
								<VSCodeTextField
									className="grow"
									value={properNouns.modelPath ?? ""}
									placeholder={t("settings:pii.properNouns.modelPathPlaceholder")}
									data-testid="pii-model-path"
									onInput={(event: unknown) => {
										const value =
											typeof event === "object" && event !== null && "target" in event
												? (event as { target: { value: string } }).target.value
												: ""
										updateProperNouns({ modelPath: value })
										// 書き換えたら、その場所を見に行き直す。
										askModel(value)
									}}
								/>
								<StandardTooltip content={t("settings:pii.properNouns.fetch")}>
									<Button
										variant="secondary"
										className="py-1"
										// 取得は操作なので、押した時点で拡張ホストへ送る。
										// **保存前の置き場所を渡す。** 渡さないと、書いたばかりの場所ではなく
										// 保存済みの場所へ 282 MB を取ってしまう。
										// **取得先も一緒に送る（`FR-PII-23h`）。** 既定の取得先は
										// 持たないので、送らなければ何も取れない。
										onClick={() =>
											vscode.postMessage({
												type: "fetchPiiNerModel",
												text: properNouns.modelPath ?? "",
												values: { modelUrl: properNouns.modelUrl ?? "" },
											})
										}
										data-testid="pii-model-fetch">
										<Download />
									</Button>
								</StandardTooltip>
							</div>
							{/*
							 * **取得先の欄（`FR-PII-23h`）。** 既定の取得先を持たないので、
							 * 書いた人だけが取得できる。書いていなければ上のボタンは理由を
							 * 出して止まる。閉鎖環境では空のままにする。
							 */}
							<label className="block mt-2">{t("settings:pii.properNouns.modelUrl")}</label>
							<VSCodeTextField
								className="w-full"
								value={properNouns.modelUrl ?? ""}
								placeholder={t("settings:pii.properNouns.modelUrlPlaceholder")}
								data-testid="pii-model-url"
								onInput={(event: unknown) => {
									const value =
										typeof event === "object" && event !== null && "target" in event
											? (event as { target: { value: string } }).target.value
											: ""
									updateProperNouns({ modelUrl: value })
								}}
							/>
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:pii.properNouns.modelUrlHelp")}
							</div>

							{/*
							 * **どこを見ているかを出す。** 出さないと、閉鎖環境の利用者はどこへ
							 * ファイルを運べばよいか分からない。欄が空なら既定の場所を見るが、
							 * その場所は画面のどこにも書いていなかった。
							 */}
							{model ? (
								<div
									className="text-sm text-vscode-descriptionForeground"
									data-testid="pii-model-status">
									<div>
										{t("settings:pii.properNouns.lookingAt")}
										<code className="ml-1">{model.directory}</code>
									</div>
									<div className={model.present ? "" : "text-vscode-errorForeground"}>
										{model.present
											? t("settings:pii.properNouns.placed", {
													size: Math.round(model.bytes / 1024 / 1024),
												})
											: t("settings:pii.properNouns.notPlaced", { count: model.missing.length })}
									</div>
								</div>
							) : null}

							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:pii.properNouns.offline")}
							</div>
						</>
					)}
				</div>
			</Section>
		</div>
	)
}
