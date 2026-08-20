import * as checkpointsIndex from "../index"
import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"

// バレル（re-export のみ）の疎通確認。値の re-export が実際に解決されることを保証する。
describe("checkpoints/index バレル", () => {
	it("RepoPerTaskCheckpointService を再エクスポートしている", () => {
		expect(checkpointsIndex.RepoPerTaskCheckpointService).toBe(RepoPerTaskCheckpointService)
	})
})
