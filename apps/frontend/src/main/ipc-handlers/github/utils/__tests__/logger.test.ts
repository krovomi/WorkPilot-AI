/**
 * @vitest-environment node
 *
 * The GitHub handlers' debug lines: written as warnings, with their context and
 * their data when given, only when the app was started with DEBUG=true.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadLogger(debug: string | undefined) {
	vi.resetModules();
	vi.stubEnv("DEBUG", debug);
	return import("../logger");
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("GitHub debug logger", () => {
	it("writes each line with its context, with or without data, under DEBUG=true", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { createContextLogger, debugLog } = await loadLogger("true");

		createContextLogger("GitHub PR").debug("polling", { prNumber: 5 });
		createContextLogger("GitHub PR").debug("done");
		debugLog("spec-utils", "written", { specId: "001" });
		debugLog("spec-utils", "skipped");

		expect(warn.mock.calls).toEqual([
			["[GitHub PR] polling", { prNumber: 5 }],
			["[GitHub PR] done"],
			["[spec-utils] written", { specId: "001" }],
			["[spec-utils] skipped"],
		]);
	});

	it.each([[undefined], ["1"], ["false"]])("stays silent when DEBUG is %j", async (debug) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { createContextLogger, debugLog } = await loadLogger(debug);

		createContextLogger("GitHub PR").debug("polling", { prNumber: 5 });
		debugLog("spec-utils", "written");

		expect(warn).not.toHaveBeenCalled();
	});
});
