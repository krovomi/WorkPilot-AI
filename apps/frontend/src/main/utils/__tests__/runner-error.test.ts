import { describe, expect, it } from "vitest";
import { decodeRunnerError } from "../runner-error";

describe("decodeRunnerError", () => {
	it("reads the runner's JSON string, without its quotes", () => {
		expect(decodeRunnerError('"Project path does not exist: /tmp/gone"')).toBe(
			"Project path does not exist: /tmp/gone",
		);
	});

	it("keeps the newlines and accents the JSON escaped", () => {
		expect(decodeRunnerError('"no_results: none\\nerror CS1002"')).toBe("no_results: none\nerror CS1002");
		expect(decodeRunnerError('"Fichier \\u00e9crit"')).toBe("Fichier écrit");
	});

	it("leaves a plain-text message as it is", () => {
		expect(decodeRunnerError("plain message")).toBe("plain message");
		expect(decodeRunnerError('Say "hello"')).toBe('Say "hello"');
	});

	it("leaves what only looks like JSON as it arrived", () => {
		expect(decodeRunnerError('"broken')).toBe('"broken');
		expect(decodeRunnerError('"a" "b"')).toBe('"a" "b"');
	});
});
