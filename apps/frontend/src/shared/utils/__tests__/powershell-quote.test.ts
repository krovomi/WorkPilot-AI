import { describe, expect, it } from "vitest";
import { escapePowerShellSingleQuoted, quotePowerShellSingle } from "../powershell-quote";

describe("PowerShell single-quoted strings", () => {
	it("keeps text without quotes as it is", () => {
		expect(quotePowerShellSingle(String.raw`C:\Program Files\App $env:PATH "x"`)).toBe(
			String.raw`'C:\Program Files\App $env:PATH "x"'`,
		);
		expect(quotePowerShellSingle("")).toBe("''");
	});

	it("doubles every character PowerShell reads as a single quote", () => {
		for (const quote of ["'", "\u2018", "\u2019", "\u201A", "\u201B"]) {
			expect(escapePowerShellSingleQuoted(`a${quote}b`)).toBe(`a${quote}${quote}b`);
		}
		expect(quotePowerShellSingle("l'app’s")).toBe("'l''app’’s'");
	});

	it("leaves the double quotes alone, which mean nothing inside single quotes", () => {
		expect(escapePowerShellSingleQuoted("\u201C\u201D\"")).toBe("\u201C\u201D\"");
	});
});
