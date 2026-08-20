import React from "react"
import {
	VSCodeCheckbox,
	VSCodeRadio,
	VSCodeRadioGroup,
	VSCodeTextArea,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, Input } from "@src/components/ui"

import {
	availableGroups,
	getGroupName,
	toggleGroup,
	type ModeFieldErrors,
	type ModeDraft,
	type ModeSource,
} from "./modeFormLogic"

export interface CreateModeDialogProps {
	draft: ModeDraft
	errors: ModeFieldErrors
	setField: <K extends keyof ModeDraft>(key: K, value: ModeDraft[K]) => void
	/** 名前入力は slug も同時に決めるので専用ハンドラを受け取る。 */
	onNameChange: (name: string) => void
	onCancel: () => void
	onCreate: () => void
}

/**
 * モードを新規作成するフルスクリーンダイアログ。
 *
 * 下書きの所有者は呼び出し側の `useModeFormState`。ここは「その下書きをどう見せ、
 * どの入力でどのフィールドを更新するか」だけを持つ。
 */
export const CreateModeDialog = ({
	draft,
	errors,
	setField,
	onNameChange,
	onCancel,
	onCreate,
}: CreateModeDialogProps) => {
	const { t } = useAppTranslation()

	return (
		<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
			<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
				<div className="flex-1 p-5 overflow-y-auto min-h-0">
					<Button variant="ghost" size="icon" onClick={onCancel} className="absolute top-5 right-5">
						<span className="codicon codicon-close"></span>
					</Button>
					<h2 className="mb-4">{t("prompts:createModeDialog.title")}</h2>
					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.name.label")}</div>
						<Input
							type="text"
							value={draft.name}
							onChange={(e) => {
								onNameChange(e.target.value)
							}}
							className="w-full"
						/>
						{errors.name && <div className="text-xs text-vscode-errorForeground mt-1">{errors.name}</div>}
					</div>
					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.slug.label")}</div>
						<Input
							type="text"
							value={draft.slug}
							onChange={(e) => {
								setField("slug", e.target.value)
							}}
							className="w-full"
						/>
						<div className="text-xs text-vscode-descriptionForeground mt-1">
							{t("prompts:createModeDialog.slug.description")}
						</div>
						{errors.slug && <div className="text-xs text-vscode-errorForeground mt-1">{errors.slug}</div>}
					</div>
					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.saveLocation.label")}</div>
						<div className="text-sm text-vscode-descriptionForeground mb-2">
							{t("prompts:createModeDialog.saveLocation.description")}
						</div>
						<VSCodeRadioGroup
							value={draft.source}
							onChange={(e: Event | React.FormEvent<HTMLElement>) => {
								const target = ((e as CustomEvent)?.detail?.target ||
									(e.target as HTMLInputElement)) as HTMLInputElement
								setField("source", target.value as ModeSource)
							}}>
							<VSCodeRadio value="global">
								{t("prompts:createModeDialog.saveLocation.global.label")}
								<div className="text-xs text-vscode-descriptionForeground mt-0.5">
									{t("prompts:createModeDialog.saveLocation.global.description")}
								</div>
							</VSCodeRadio>
							<VSCodeRadio value="project">
								{t("prompts:createModeDialog.saveLocation.project.label")}
								<div className="text-xs text-vscode-descriptionForeground mt-0.5">
									{t("prompts:createModeDialog.saveLocation.project.description")}
								</div>
							</VSCodeRadio>
						</VSCodeRadioGroup>
					</div>

					<div style={{ marginBottom: "16px" }}>
						<div style={{ fontWeight: "bold", marginBottom: "4px" }}>
							{t("prompts:createModeDialog.roleDefinition.label")}
						</div>
						<div
							style={{
								fontSize: "13px",
								color: "var(--vscode-descriptionForeground)",
								marginBottom: "8px",
							}}>
							{t("prompts:createModeDialog.roleDefinition.description")}
						</div>
						<VSCodeTextArea
							resize="vertical"
							value={draft.roleDefinition}
							onChange={(e) => {
								setField("roleDefinition", (e.target as HTMLTextAreaElement).value)
							}}
							rows={4}
							className="w-full"
						/>
						{errors.roleDefinition && (
							<div className="text-xs text-vscode-errorForeground mt-1">{errors.roleDefinition}</div>
						)}
					</div>

					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.description.label")}</div>
						<div className="text-[13px] text-vscode-descriptionForeground mb-2">
							{t("prompts:createModeDialog.description.description")}
						</div>
						<VSCodeTextField
							value={draft.description}
							onChange={(e) => {
								setField("description", (e.target as HTMLInputElement).value)
							}}
							className="w-full"
						/>
						{errors.description && (
							<div className="text-xs text-vscode-errorForeground mt-1">{errors.description}</div>
						)}
					</div>

					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.whenToUse.label")}</div>
						<div className="text-[13px] text-vscode-descriptionForeground mb-2">
							{t("prompts:createModeDialog.whenToUse.description")}
						</div>
						<VSCodeTextArea
							resize="vertical"
							value={draft.whenToUse}
							onChange={(e) => {
								setField("whenToUse", (e.target as HTMLTextAreaElement).value)
							}}
							rows={3}
							className="w-full"
						/>
					</div>
					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.tools.label")}</div>
						<div className="text-[13px] text-vscode-descriptionForeground mb-2">
							{t("prompts:createModeDialog.tools.description")}
						</div>
						<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
							{availableGroups.map((group) => (
								<VSCodeCheckbox
									key={group}
									checked={draft.groups.some((g) => getGroupName(g) === group)}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target =
											(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
										setField("groups", toggleGroup(draft.groups, group, target.checked))
									}}>
									{t(`prompts:tools.toolNames.${group}`)}
								</VSCodeCheckbox>
							))}
						</div>
						{errors.groups && (
							<div className="text-xs text-vscode-errorForeground mt-1">{errors.groups}</div>
						)}
					</div>
					<div className="mb-4">
						<div className="font-bold mb-1">{t("prompts:createModeDialog.customInstructions.label")}</div>
						<div className="text-[13px] text-vscode-descriptionForeground mb-2">
							{t("prompts:createModeDialog.customInstructions.description")}
						</div>
						<VSCodeTextArea
							resize="vertical"
							value={draft.customInstructions}
							onChange={(e) => {
								setField("customInstructions", (e.target as HTMLTextAreaElement).value)
							}}
							rows={4}
							className="w-full"
						/>
					</div>
				</div>
				<div className="flex justify-end p-3 px-5 gap-2 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
					<Button variant="secondary" onClick={onCancel}>
						{t("prompts:createModeDialog.buttons.cancel")}
					</Button>
					<Button variant="primary" onClick={onCreate}>
						{t("prompts:createModeDialog.buttons.create")}
					</Button>
				</div>
			</div>
		</div>
	)
}
