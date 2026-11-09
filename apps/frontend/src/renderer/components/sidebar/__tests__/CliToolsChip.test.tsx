/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { summarizeCliPresence } from "../CliToolsChip";

describe("the CLI chip of the menu", () => {
	it("counts the installed CLIs once every check has answered", () => {
		expect(summarizeCliPresence({ "claude-code": "installed", codex: "missing" }, 2)).toEqual({
			installed: 1,
			total: 2,
			checked: true,
		});
	});

	it("is still checking while a CLI has not answered", () => {
		expect(summarizeCliPresence({ codex: "missing" }, 2).checked).toBe(false);
	});
});
