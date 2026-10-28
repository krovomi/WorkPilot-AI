import { describe, expect, it } from "vitest";
import { devEnvFilePaths } from "../dev-env-files";

describe("development .env-files", () => {
	it("are not read by a packaged app, wherever it is launched from", () => {
		expect(devEnvFilePaths("/opt/WorkPilot/resources/app.asar/out/main", "/tmp/evil", true)).toEqual([]);
	});

	it("are looked up next to the checkout in development", () => {
		const paths = devEnvFilePaths("/repo/apps/frontend/out/main", "/repo", false);
		expect(paths[0]).toMatch(/[\\/]repo[\\/]\.env-files[\\/]\.env$/);
		expect(paths).toHaveLength(3);
	});
});
