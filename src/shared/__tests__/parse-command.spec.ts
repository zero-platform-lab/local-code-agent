// npx vitest run shared/__tests__/parse-command.spec.ts

// shell-quote の parse は実際には throw しない（parse.js に throw 無し）。
// parseCommandLine の catch フォールバックは防御コードで通常入力では到達不能なため、
// センチネル "__FORCE_THROW__" を含むときだけ throw するモックで意図的に踏む。
// それ以外は実 parse に委譲するので通常経路の挙動は変わらない。
vi.mock("shell-quote", async (importOriginal) => {
	const actual = await importOriginal<typeof import("shell-quote")>()
	return {
		...actual,
		parse: (str: string) => {
			if (typeof str === "string" && str.includes("__FORCE_THROW__")) {
				throw new Error("forced parse error")
			}
			return (actual as unknown as { parse: (s: string) => unknown }).parse(str)
		},
	}
})

import { parseCommand } from "../parse-command"

describe("parseCommand", () => {
	describe("空・空白", () => {
		it("空文字は空配列", () => {
			expect(parseCommand("")).toEqual([])
		})
		it("空白のみは空配列", () => {
			expect(parseCommand("   ")).toEqual([])
		})
		it("undefined 相当（optional chain）でも落ちない", () => {
			expect(parseCommand(undefined as unknown as string)).toEqual([])
		})
	})

	describe("複数行", () => {
		it("改行で分割し空行は飛ばす", () => {
			expect(parseCommand("echo a\n\n   \necho b")).toEqual(["echo a", "echo b"])
		})
		it("CRLF/CR も区切りとして扱う", () => {
			expect(parseCommand("echo a\r\necho b\recho c")).toEqual(["echo a", "echo b", "echo c"])
		})
	})

	describe("チェーン演算子", () => {
		it("&& で分割", () => {
			expect(parseCommand("echo a && echo b")).toEqual(["echo a", "echo b"])
		})
		it("|| ; | & で分割", () => {
			expect(parseCommand("a || b ; c | d & e")).toEqual(["a", "b", "c", "d", "e"])
		})
	})

	describe("リダイレクト演算子（> はコマンドの一部）", () => {
		it("> はコマンドに残る", () => {
			expect(parseCommand("a > b")).toEqual(["a > b"])
		})
		it("PowerShell リダイレクト 2>&1 を保持", () => {
			expect(parseCommand("cmd 2>&1")).toEqual(["cmd 2>&1"])
		})
	})

	describe("サブシェル・プロセス置換", () => {
		it("$(...) は独立したコマンドとして抽出（前にコマンドあり）", () => {
			expect(parseCommand("echo $(date)")).toEqual(["echo", "date"])
		})
		it("$(...) 単独（前にコマンドなし）", () => {
			expect(parseCommand("$(date)")).toEqual(["date"])
		})
		it("バッククォートのサブシェル", () => {
			expect(parseCommand("echo `whoami`")).toEqual(["echo", "whoami"])
		})
		it("プロセス置換 <(...) を抽出", () => {
			expect(parseCommand("diff <(sort a) <(sort b)")).toEqual(["diff", "sort a", "sort b"])
		})
	})

	describe("展開・変数・クォート保持", () => {
		it("算術式 $((...))", () => {
			expect(parseCommand("echo $((1+2))")).toEqual(["echo $((1+2))"])
		})
		it("算術式 $[...]", () => {
			expect(parseCommand("echo $[1+2]")).toEqual(["echo $[1+2]"])
		})
		it("パラメータ展開 ${...}", () => {
			expect(parseCommand("echo ${HOME}")).toEqual(["echo ${HOME}"])
		})
		it("単純変数 $var", () => {
			expect(parseCommand("echo $count")).toEqual(["echo $count"])
		})
		it("特殊変数 $?", () => {
			expect(parseCommand("echo $?")).toEqual(["echo $?"])
		})
		it("ダブルクォートを保持", () => {
			expect(parseCommand('echo "hello world"')).toEqual(['echo "hello world"'])
		})
	})

	describe("shell-quote が throw した場合のフォールバック", () => {
		let warnSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		})
		afterEach(() => {
			warnSpy.mockRestore()
		})

		it("演算子で単純分割し警告を出す", () => {
			expect(parseCommand("echo __FORCE_THROW__ && ls")).toEqual(["echo __FORCE_THROW__", "ls"])
			expect(warnSpy).toHaveBeenCalledWith(
				"shell-quote parse error:",
				"forced parse error",
				"for command:",
				expect.stringContaining("__FORCE_THROW__"),
			)
		})

		it("フォールバックでもプレースホルダを復元する", () => {
			// クォートは __QUOTE_0__ に退避されるが、sentinel が残るので parse は throw する
			expect(parseCommand('echo "hi" __FORCE_THROW__')).toEqual(['echo "hi" __FORCE_THROW__'])
		})
	})
})
