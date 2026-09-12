import * as path from "path"

import { getGlobalAgentDirectory, getGlobalAgentsDirectory } from "../agent-config"

/**
 * 取得したスキルの置き場所（`FR-EXT-05e`）。
 *
 * **`~/.agent/skills` とは分ける。** 利用者が手で置いたスキルと同じ場所へ clone すると、
 * 取得のたびにどれを消してよいか判別できなくなる。場所を分ければ、取得の処理が
 * `skills/` に触れる経路そのものが無くなる。
 *
 * **`~/.agents` 側へは置かない。** あちらはほかの AI コーディングツールと共有する場所
 * なので、`.git` を置くと他ツールが管理しているものと混ざる。複製したいときは
 * `FR-EXT-05f` の複製として別に扱う。
 */
export function skillSourcesBaseDir(): string {
	return path.join(getGlobalAgentDirectory(), "skill-sources")
}

/**
 * ほかの AI コーディングツールと共有するスキルの置き場所（`FR-EXT-05f`）。
 *
 * ここへ複製すると、ほかのツールからも同じスキルが見える。**ほかのツールが置いた
 * ものが同居している**ので、こちらが置いたものだけを目印で見分ける（`FR-EXT-05f2`）。
 */
export function sharedSkillsDir(): string {
	return path.join(getGlobalAgentsDirectory(), "skills")
}
