import { describe, it, expect } from "vitest"

import { getLanguageFromPath } from "../getLanguageFromPath"

describe("getLanguageFromPath", () => {
	it("returns javascript for .js files", () => {
		expect(getLanguageFromPath("/path/to/file.js")).toBe("javascript")
	})

	it("returns typescript for .ts files", () => {
		expect(getLanguageFromPath("file.ts")).toBe("typescript")
	})

	it("returns python for .py files", () => {
		expect(getLanguageFromPath("script.py")).toBe("python")
	})

	it("returns html for .html and .htm files", () => {
		expect(getLanguageFromPath("index.html")).toBe("html")
		expect(getLanguageFromPath("page.htm")).toBe("html")
	})

	it("returns yaml for .yaml and .yml files", () => {
		expect(getLanguageFromPath("config.yaml")).toBe("yaml")
		expect(getLanguageFromPath("config.yml")).toBe("yaml")
	})

	it("returns bash for .sh, .bash, .zsh files", () => {
		expect(getLanguageFromPath("script.sh")).toBe("bash")
		expect(getLanguageFromPath("script.bash")).toBe("bash")
		expect(getLanguageFromPath("script.zsh")).toBe("bash")
	})

	it("returns undefined for unknown extensions", () => {
		expect(getLanguageFromPath("file.xyz")).toBeUndefined()
	})

	it("returns undefined for files without extension", () => {
		expect(getLanguageFromPath("Makefile")).toBeUndefined()
	})

	it("handles case-insensitive extensions", () => {
		expect(getLanguageFromPath("FILE.JS")).toBe("javascript")
		expect(getLanguageFromPath("FILE.PY")).toBe("python")
	})

	it("handles multiple dots in path", () => {
		expect(getLanguageFromPath("module.test.ts")).toBe("typescript")
	})

	// Additional extensions for full map coverage
	it("maps jsx extension", () => {
		expect(getLanguageFromPath("component.jsx")).toBe("jsx")
	})

	it("maps tsx extension", () => {
		expect(getLanguageFromPath("component.tsx")).toBe("tsx")
	})

	it("maps css extension", () => {
		expect(getLanguageFromPath("style.css")).toBe("css")
	})

	it("maps ruby extension", () => {
		expect(getLanguageFromPath("script.rb")).toBe("ruby")
	})

	it("maps php extension", () => {
		expect(getLanguageFromPath("index.php")).toBe("php")
	})

	it("maps java extension", () => {
		expect(getLanguageFromPath("Main.java")).toBe("java")
	})

	it("maps csharp extension", () => {
		expect(getLanguageFromPath("Program.cs")).toBe("csharp")
	})

	it("maps go extension", () => {
		expect(getLanguageFromPath("main.go")).toBe("go")
	})

	it("maps rust extension", () => {
		expect(getLanguageFromPath("main.rs")).toBe("rust")
	})

	it("maps kotlin extension", () => {
		expect(getLanguageFromPath("Main.kt")).toBe("kotlin")
	})

	it("maps swift extension", () => {
		expect(getLanguageFromPath("App.swift")).toBe("swift")
	})

	it("maps scala extension", () => {
		expect(getLanguageFromPath("App.scala")).toBe("scala")
	})

	it("maps json extension", () => {
		expect(getLanguageFromPath("data.json")).toBe("json")
	})

	it("maps xml extension", () => {
		expect(getLanguageFromPath("config.xml")).toBe("xml")
	})

	it("maps markdown extension", () => {
		expect(getLanguageFromPath("README.md")).toBe("markdown")
	})

	it("maps csv extension", () => {
		expect(getLanguageFromPath("data.csv")).toBe("csv")
	})

	it("maps powershell extension", () => {
		expect(getLanguageFromPath("script.ps1")).toBe("powershell")
	})

	it("maps toml extension", () => {
		expect(getLanguageFromPath("config.toml")).toBe("toml")
	})

	it("maps ini/cfg/conf extensions", () => {
		expect(getLanguageFromPath("config.ini")).toBe("ini")
		expect(getLanguageFromPath("config.cfg")).toBe("ini")
		expect(getLanguageFromPath("config.conf")).toBe("ini")
	})

	it("maps sql extension", () => {
		expect(getLanguageFromPath("query.sql")).toBe("sql")
	})

	it("maps graphql/gql extensions", () => {
		expect(getLanguageFromPath("schema.graphql")).toBe("graphql")
		expect(getLanguageFromPath("query.gql")).toBe("graphql")
	})

	it("maps latex extension", () => {
		expect(getLanguageFromPath("paper.tex")).toBe("latex")
	})

	it("maps svg extension", () => {
		expect(getLanguageFromPath("icon.svg")).toBe("svg")
	})

	it("maps text extension", () => {
		expect(getLanguageFromPath("notes.txt")).toBe("text")
	})

	it("maps C-family extensions", () => {
		expect(getLanguageFromPath("main.c")).toBe("c")
		expect(getLanguageFromPath("main.cpp")).toBe("cpp")
		expect(getLanguageFromPath("header.h")).toBe("c")
		expect(getLanguageFromPath("header.hpp")).toBe("cpp")
	})

	it("maps functional language extensions", () => {
		expect(getLanguageFromPath("Main.hs")).toBe("haskell")
		expect(getLanguageFromPath("Main.lhs")).toBe("haskell")
		expect(getLanguageFromPath("Main.elm")).toBe("elm")
		expect(getLanguageFromPath("core.clj")).toBe("clojure")
		expect(getLanguageFromPath("core.cljs")).toBe("clojure")
		expect(getLanguageFromPath("mod.erl")).toBe("erlang")
		expect(getLanguageFromPath("mod.ex")).toBe("elixir")
		expect(getLanguageFromPath("mod.exs")).toBe("elixir")
	})

	it("maps mobile extensions", () => {
		expect(getLanguageFromPath("main.dart")).toBe("dart")
		expect(getLanguageFromPath("ViewController.m")).toBe("objectivec")
		expect(getLanguageFromPath("ViewController.mm")).toBe("objectivec")
	})

	it("maps game dev extensions", () => {
		expect(getLanguageFromPath("script.lua")).toBe("lua")
		expect(getLanguageFromPath("scene.gd")).toBe("gdscript")
		expect(getLanguageFromPath("game.unity")).toBe("csharp")
	})

	it("maps data science extensions", () => {
		expect(getLanguageFromPath("analysis.r")).toBe("r")
		expect(getLanguageFromPath("compute.jl")).toBe("julia")
		expect(getLanguageFromPath("notebook.ipynb")).toBe("jupyter")
	})

	// --- Mutation kills ---
	it("uses the last dot for extension extraction", () => {
		// If mutation changes pop() to shift(), we'd get the wrong extension
		expect(getLanguageFromPath("my.file.py")).toBe("python")
	})

	it("uses case-insensitive matching via toLowerCase (mutation: removing toLowerCase)", () => {
		expect(getLanguageFromPath("file.PY")).toBe("python")
		expect(getLanguageFromPath("file.Py")).toBe("python")
	})

	it("falls back to an empty extension when the path has none", () => {
		// `"".split(".").pop()` は "" を返すので `|| ""` の右辺を踏む経路。
		expect(getLanguageFromPath("")).toBeUndefined()
		expect(getLanguageFromPath("Makefile")).toBeUndefined()
		expect(getLanguageFromPath("archive.")).toBeUndefined()
	})
})
