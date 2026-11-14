/**
 * `pnpm run dev` starts `npm run dev:vite` (scripts/dev-elevated.cjs). pnpm
 * hands its scripts `npm_config_manage_package_manager_versions`, a pnpm-only
 * setting, and npm 11 warns on every `npm_config_*` it does not know
 * ("npm warn Unknown env config "manage-package-manager-versions""). The npm
 * the launcher starts must not see it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { npmEnv } from "../../../scripts/dev-elevated.cjs";

const frontendDir = path.resolve(__dirname, "../../..");

describe("npmEnv", () => {
	it("drops the pnpm-only setting npm warns about, whatever its case", () => {
		const env = npmEnv({
			npm_config_manage_package_manager_versions: "false",
			NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
		});
		expect(env).toEqual({});
	});

	it("keeps everything else, npm's own settings included", () => {
		const kept = {
			PATH: "/usr/bin",
			DEBUG: "true",
			WORKPILOT_DEVTOOLS: "1",
			npm_config_https_proxy: "http://127.0.0.1:3128",
			npm_config_user_agent: "pnpm/12.18.0",
			pnpm_config_verify_deps_before_run: "false",
		};
		expect(npmEnv({ ...kept, npm_config_manage_package_manager_versions: "false" })).toEqual(
			kept,
		);
	});

	it("does not touch the env it is given", () => {
		const env = { npm_config_manage_package_manager_versions: "false" };
		npmEnv(env);
		expect(env).toEqual({ npm_config_manage_package_manager_versions: "false" });
	});
});

describe("frontend scripts run by pnpm", () => {
	it("never start npm, which would get pnpm's env", () => {
		const { scripts } = JSON.parse(
			readFileSync(path.join(frontendDir, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		const callingNpm = Object.entries(scripts)
			.filter(([, command]) => /(^|[\s&|;(])npm\s/.test(command))
			.map(([name]) => name);
		expect(callingNpm).toEqual([]);
	});
});
