import { describe, expect, it } from "vitest";
import {
	ARTIFACT_NAME_MAX,
	isArtifactName,
	readRunnerUrl,
	RUNNER_URL_MAX,
	toArtifactName,
} from "../browser-agent-inputs";

describe("readRunnerUrl", () => {
	it.each([
		["http://localhost:3000", "http://localhost:3000/"],
		["https://example.com/a?b=c#d", "https://example.com/a?b=c#d"],
		["HTTPS://Example.com", "https://example.com/"],
	])("keeps %s", (raw, href) => {
		expect(readRunnerUrl(raw)).toBe(href);
	});

	it("keeps an address of the longest length", () => {
		const base = "https://example.com/";
		const raw = base + "a".repeat(RUNNER_URL_MAX - base.length);
		expect(readRunnerUrl(raw)).toBe(raw);
		expect(readRunnerUrl(`${raw}a`)).toBeNull();
	});

	it.each([
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ftp://example.com/",
		"-http://example.com",
		"http://example.com/\t",
		"http://example.com/\u007f",
		"http://example.com/\u009f",
		"http://",
		"",
		undefined,
		1,
	])("refuses %j", (raw) => {
		expect(readRunnerUrl(raw)).toBeNull();
	});
});

describe("isArtifactName", () => {
	it.each(["home", "home_v1.2-b", "_x", ".x", "a".repeat(ARTIFACT_NAME_MAX)])("accepts %s", (name) => {
		expect(isArtifactName(name)).toBe(true);
	});

	it.each(["", "-x", "--name=x", "a b", "a/b", "a\\b", "é", "a".repeat(ARTIFACT_NAME_MAX + 1), 3, null])(
		"refuses %j",
		(name) => {
			expect(isArtifactName(name)).toBe(false);
		},
	);
});

describe("toArtifactName", () => {
	it.each([
		["  login page  ", "login_page"],
		["--name=x", "name_x"],
		["../outside/", "outside"],
		[".hidden.", "hidden"],
		["", ""],
		["///", ""],
	])("reduces %j to %j", (raw, name) => {
		expect(toArtifactName(raw)).toBe(name);
	});

	it("gives a name the runner receives as it is", () => {
		for (const raw of ["login page", "-x", "café", "a".repeat(300)]) {
			const name = toArtifactName(raw);
			expect(isArtifactName(name), raw).toBe(true);
		}
	});
});
