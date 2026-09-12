import * as path from "path"

import { getGlobalAgentDirectory } from "../agent-config"

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
