/**
 * @vitest-environment node
 *
 * The project's CAPTURES_* settings: defaults of `pr_captures/settings.py`
 * when nothing is written, and a value from the renderer put back in the
 * backend's shape before it reaches `.workpilot/.env` (no added line, no
 * branch the backend would refuse).
 */

import { describe, expect, it } from "vitest";
import {
	applyCapturesToEnv,
	capturesFromEnv,
	capturesTemplateLines,
	cleanSelectors,
} from "../captures-env";

describe("capturesFromEnv", () => {
	it("fills in the backend's defaults", () => {
		expect(capturesFromEnv({})).toEqual({
			mode: "auto",
			compare: true,
			mask: true,
			maskSelectors: "",
			publish: "auto",
			publishUnchecked: false,
			retentionDays: 30,
			branch: "workpilot-captures",
		});
	});

	it("reads what the file says, and ignores what the backend would", () => {
		expect(
			capturesFromEnv({
				CAPTURES_MODE: "Never",
				CAPTURES_MASK: "off",
				CAPTURES_PUBLISH: "review",
				CAPTURES_RETENTION_DAYS: "0",
				CAPTURES_BRANCH: "bad..branch",
			}),
		).toMatchObject({ mode: "never", mask: false, publish: "review", retentionDays: 0, branch: "workpilot-captures" });
	});
});

describe("applyCapturesToEnv", () => {
	it("writes the fields the screen sent", () => {
		const vars: Record<string, string> = {};
		applyCapturesToEnv(vars, {
			mode: "always",
			publish: "review",
			mask: false,
			compare: true,
			retentionDays: 7,
			maskSelectors: ".name, #account",
			branch: "team/captures",
		});
		expect(vars).toEqual({
			CAPTURES_MODE: "always",
			CAPTURES_PUBLISH: "review",
			CAPTURES_MASK: "false",
			CAPTURES_COMPARE: "true",
			CAPTURES_RETENTION_DAYS: "7",
			CAPTURES_MASK_SELECTORS: ".name,#account",
			CAPTURES_BRANCH: "team/captures",
		});
	});

	it("never lets a value add a line or a key to the file", () => {
		const vars: Record<string, string> = { CAPTURES_BRANCH: "kept" };
		applyCapturesToEnv(vars, {
			// The renderer is not trusted: these come in as anything.
			mode: "auto\nGITHUB_TOKEN=x" as "auto",
			publish: "yes" as "auto",
			retentionDays: -1,
			maskSelectors: ".a\nGITHUB_TOKEN=x, 'b'",
			branch: "main\nX=1",
		});
		expect(vars.CAPTURES_MODE).toBeUndefined();
		expect(vars.CAPTURES_PUBLISH).toBeUndefined();
		expect(vars.CAPTURES_RETENTION_DAYS).toBeUndefined();
		expect(vars.CAPTURES_MASK_SELECTORS).not.toMatch(/[\r\n'"]/);
		expect(vars.CAPTURES_BRANCH).toBe("kept");
		expect(capturesTemplateLines(vars).split("\n")).toHaveLength(8);
	});

	it("removes the selectors and the branch when emptied or set back to the default", () => {
		const vars: Record<string, string> = {
			CAPTURES_MASK_SELECTORS: ".a",
			CAPTURES_BRANCH: "team/captures",
		};
		applyCapturesToEnv(vars, { maskSelectors: " ", branch: "workpilot-captures" });
		expect(vars).toEqual({});
	});
});

describe("cleanSelectors", () => {
	it("keeps 30 selectors of 200 characters at most", () => {
		const many = Array.from({ length: 40 }, (_, i) => `.s${i}`).join(",");
		expect(cleanSelectors(many).split(",")).toHaveLength(30);
		expect(cleanSelectors(`.${"x".repeat(250)},.ok`)).toBe(".ok");
	});
});

describe("capturesTemplateLines", () => {
	it("writes a set key, comments an unset one with its default", () => {
		expect(capturesTemplateLines({ CAPTURES_MODE: "never" })).toContain("CAPTURES_MODE=never");
		expect(capturesTemplateLines({})).toContain("# CAPTURES_PUBLISH=auto");
	});
});
