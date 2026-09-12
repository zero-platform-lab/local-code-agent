// npx vitest run services/skills/__tests__/skillSourcePaths.spec.ts
//
// 取得したスキルの置き場所。**`~/.agent/skills` とは別**であることがこの層の要点で、
// ここが同じになると、取得の処理が利用者の置いたスキルを消せてしまう（FR-EXT-05e）。

import * as path from "path"

import { getGlobalAgentDirectory, getGlobalAgentsDirectory } from "../../agent-config"

import { sharedSkillsDir, skillSourcesBaseDir } from "../skillSourcePaths"

describe("skillSourcesBaseDir", () => {
	it("`~/.agent/skill-sources` を返す", () => {
		expect(skillSourcesBaseDir()).toBe(path.join(getGlobalAgentDirectory(), "skill-sources"))
	})

	it("利用者が手で置くスキルの場所とは別（FR-EXT-05e）", () => {
		expect(skillSourcesBaseDir()).not.toBe(path.join(getGlobalAgentDirectory(), "skills"))
	})
})

describe("sharedSkillsDir", () => {
	it("`~/.agents/skills` を返す（FR-EXT-05f）", () => {
		expect(sharedSkillsDir()).toBe(path.join(getGlobalAgentsDirectory(), "skills"))
	})

	it("取得元を置く場所とは別。`.git` を共有する場所へ置かない", () => {
		expect(sharedSkillsDir()).not.toBe(skillSourcesBaseDir())
	})
})
