import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import type { ModeSource } from "./modeFormLogic"

export interface ImportModeDialogProps {
	/** 取り込み先（プロジェクト / グローバル）。 */
	level: ModeSource
	onLevelChange: (level: ModeSource) => void
	/** 取り込み実行中は二重送信を防ぐためボタンを無効化する。 */
	isImporting: boolean
	onCancel: () => void
	onImport: () => void
}

/** モード定義ファイルの取り込み先を選ばせるダイアログ。 */
export const ImportModeDialog = ({ level, onLevelChange, isImporting, onCancel, onImport }: ImportModeDialogProps) => {
	const { t } = useAppTranslation()

	return (
		<div className="fixed inset-0 flex items-center justify-center bg-black/50 z-[1000]">
			<div className="bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded-lg shadow-lg p-6 max-w-md w-full">
				<h3 className="text-lg font-semibold mb-4">{t("prompts:modes.importMode")}</h3>
				<p className="text-sm text-vscode-descriptionForeground mb-4">{t("prompts:importMode.selectLevel")}</p>
				<div className="space-y-3 mb-6">
					<label className="flex items-start gap-2 cursor-pointer">
						<input
							type="radio"
							name="importLevel"
							value="project"
							className="mt-1"
							checked={level === "project"}
							onChange={() => onLevelChange("project")}
						/>
						<div>
							<div className="font-medium">{t("prompts:importMode.project.label")}</div>
							<div className="text-xs text-vscode-descriptionForeground">
								{t("prompts:importMode.project.description")}
							</div>
						</div>
					</label>
					<label className="flex items-start gap-2 cursor-pointer">
						<input
							type="radio"
							name="importLevel"
							value="global"
							className="mt-1"
							checked={level === "global"}
							onChange={() => onLevelChange("global")}
						/>
						<div>
							<div className="font-medium">{t("prompts:importMode.global.label")}</div>
							<div className="text-xs text-vscode-descriptionForeground">
								{t("prompts:importMode.global.description")}
							</div>
						</div>
					</label>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="secondary" onClick={onCancel} data-testid="cancel-import-button">
						{t("prompts:createModeDialog.buttons.cancel")}
					</Button>
					<Button
						variant="primary"
						onClick={onImport}
						disabled={isImporting}
						data-testid="import-mode-button">
						{isImporting ? t("prompts:importMode.importing") : t("prompts:importMode.import")}
					</Button>
				</div>
			</div>
		</div>
	)
}
