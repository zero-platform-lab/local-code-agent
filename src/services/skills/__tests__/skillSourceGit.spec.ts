// npx vitest run services/skills/__tests__/skillSourceGit.spec.ts

import { buildGitInvocation, preferProxySideDns, redactProxyUrl } from "../skillSourceGit"

const resolveEffectiveProxy = vi.hoisted(() => vi.fn())

vi.mock("../../../utils/proxyDispatcher", () => ({ resolveEffectiveProxy }))

const proxyOf = (invocation: { config: string[] }) =>
	invocation.config.find((entry) => entry.startsWith("http.proxy="))?.slice("http.proxy=".length)

describe("preferProxySideDns（FR-NET-12a1 / FR-EXT-05b2）", () => {
	it.each([
		["socks5://host:1080", "socks5h://host:1080"],
		["SOCKS5://host:1080", "socks5h://host:1080"],
		["socks4://host:1080", "socks4a://host:1080"],
	])("%s を %s へ書き換える", (input, expected) => {
		expect(preferProxySideDns(input)).toBe(expected)
	})

	it.each(["socks5h://host:1080", "socks4a://host:1080", "http://host:3128", "https://host:3128"])(
		"%s はそのまま通す",
		(input) => {
			expect(preferProxySideDns(input)).toBe(input)
		},
	)
})

describe("redactProxyUrl（FR-EXT-06e）", () => {
	it("利用者名とパスワードを伏せる", () => {
		expect(redactProxyUrl("socks5h://user:secret@host:1080")).toBe("socks5h://<伏せた>@host:1080")
	})

	it("利用者名だけでも伏せる", () => {
		expect(redactProxyUrl("http://user@host:3128")).toBe("http://<伏せた>@host:3128")
	})

	it("資格情報が無ければ変えない", () => {
		expect(redactProxyUrl("http://host:3128")).toBe("http://host:3128")
	})
})

describe("buildGitInvocation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resolveEffectiveProxy.mockReturnValue({ url: undefined, source: "none" })
	})

	it("入力を待たずに失敗させる設定を必ず渡す（FR-EXT-06f）", () => {
		expect(buildGitInvocation("https").env.GIT_TERMINAL_PROMPT).toBe("0")
	})

	it("proxy が無ければ設定を渡さない", () => {
		const invocation = buildGitInvocation("https")

		expect(invocation.config).toEqual([])
		expect(invocation.proxyIgnored).toBe(false)
		expect(invocation.proxyForLog).toBeUndefined()
	})

	it("LLM 側と同じ解決を使う（FR-NET-13a）", () => {
		buildGitInvocation("https", { mode: "custom", url: "http://host:3128" })

		expect(resolveEffectiveProxy).toHaveBeenCalledWith({ mode: "custom", url: "http://host:3128" })
	})

	it("直結を選んだときは設定を渡さない", () => {
		resolveEffectiveProxy.mockReturnValue({ url: undefined, source: "profile-direct" })

		expect(buildGitInvocation("https", { mode: "direct" }).config).toEqual([])
	})

	it("解決した URL を http.proxy として渡す", () => {
		resolveEffectiveProxy.mockReturnValue({ url: "http://host:3128", source: "profile" })

		expect(proxyOf(buildGitInvocation("https"))).toBe("http://host:3128")
	})

	it("SOCKS は proxy 側で名前を解決する形へ書き換えて渡す", () => {
		resolveEffectiveProxy.mockReturnValue({ url: "socks5://host:1080", source: "profile" })

		expect(proxyOf(buildGitInvocation("https"))).toBe("socks5h://host:1080")
	})

	it("SSH の取得元には proxy を渡さず、無視されることを返す（FR-EXT-05b3）", () => {
		resolveEffectiveProxy.mockReturnValue({ url: "socks5://host:1080", source: "profile" })

		const invocation = buildGitInvocation("ssh", { mode: "custom", url: "socks5://host:1080" })

		expect(invocation.config).toEqual([])
		expect(invocation.proxyIgnored).toBe(true)
	})

	it("proxy が無ければ、SSH でも無視されたとは言わない", () => {
		expect(buildGitInvocation("ssh").proxyIgnored).toBe(false)
	})

	it("記録へ出す URL から資格情報を落とす（FR-EXT-06e）", () => {
		resolveEffectiveProxy.mockReturnValue({ url: "socks5://user:secret@host:1080", source: "profile" })

		const invocation = buildGitInvocation("https")

		expect(invocation.proxyForLog).toBe("socks5h://<伏せた>@host:1080")
		expect(invocation.proxyForLog).not.toContain("secret")
	})
})
