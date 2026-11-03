/**
 * The « Outils CLI » panel order: installed first, then missing, alphabetical
 * (case-insensitive) in each group.
 */
import { describe, expect, it } from "vitest";
import { type CliToolId, orderCliTools } from "./cli-tool-order";

const ALL: readonly CliToolId[] = [
	"claude-code",
	"copilot",
	"codex",
	"opencode",
	"antigravity",
	"pi",
	"gemini-cli",
	"hermes",
];

describe("orderCliTools", () => {
	it("puts installed CLIs first, then missing ones, each group alphabetical", () => {
		const order = orderCliTools(ALL, {
			"claude-code": "installed",
			copilot: "installed",
			codex: "installed",
			opencode: "installed",
			antigravity: "missing",
			pi: "missing",
			"gemini-cli": "missing",
			hermes: "installed",
		});
		expect(order).toEqual([
			"claude-code",
			"codex",
			"copilot",
			"hermes",
			"opencode",
			"antigravity",
			"gemini-cli",
			"pi",
		]);
	});

	it("ignores case: « pi » sorts among the P, not after every capital", () => {
		const order = orderCliTools(["pi", "opencode", "antigravity"], {
			pi: "installed",
			opencode: "installed",
			antigravity: "installed",
		});
		expect(order).toEqual(["antigravity", "opencode", "pi"]);
	});

	it("keeps a CLI whose check has not answered with the installed ones", () => {
		const order = orderCliTools(["pi", "codex", "antigravity"], { antigravity: "missing" });
		expect(order).toEqual(["codex", "pi", "antigravity"]);
	});

	it("does not mutate its input", () => {
		const input: CliToolId[] = ["pi", "codex"];
		orderCliTools(input, {});
		expect(input).toEqual(["pi", "codex"]);
	});
});
