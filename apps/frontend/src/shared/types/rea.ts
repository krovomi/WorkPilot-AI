/**
 * REA (npm `rea-agents`): what a shipped artifact reveals, read statically.
 *
 * WorkPilot runs one REA release, pinned in `apps/backend/rea/pin.json`. The
 * sidebar badge installs that exact release and nothing else: REA changes its
 * tools from one week to the next, so `@latest` is never asked for.
 * `tests/test_rea_frontend_pin.py` keeps `REA_PIN` equal to `pin.json`.
 */

export const REA_PIN = {
	package: "rea-agents",
	version: "6.9.0",
	/** Node.js versions the release accepts (its package.json `engines`). */
	node: ["^22.23.4", "^24.22.1", ">=26.12.1"],
} as const;

/** What `npm install -g` is asked for: the package at the pinned version. */
export const REA_SPEC = `${REA_PIN.package}@${REA_PIN.version}`;

export const REA_DOCS_URL = "https://github.com/morluto/rea";

/**
 * - `ready`: `rea` on PATH leads to the pinned release.
 * - `other_version`: `rea` is installed at another version; WorkPilot does not run it.
 * - `absent`: no `rea` on PATH (WorkPilot can still fetch it with npx).
 * - `node_missing` / `node_too_old`: no Node.js REA accepts.
 */
export type ReaState = "ready" | "other_version" | "absent" | "node_missing" | "node_too_old";

export interface ReaStatus {
	state: ReaState;
	/** The pinned release WorkPilot runs. */
	pinned: string;
	/** Version of the `rea-agents` package `rea` leads to, when one is found. */
	installedVersion?: string;
	nodeVersion?: string;
	/** Set when the check itself failed. */
	error?: string;
}

export type ReaInstallError =
	/** No native npm, or no Node.js REA accepts. */
	| "node_required"
	/** npm failed: `detail` holds its last output. */
	| "failed"
	/** npm succeeded but the check still does not find the pinned release. */
	| "not_on_path"
	/** An install is already running. */
	| "busy";

export interface ReaInstallResult {
	success: boolean;
	/** The check run after the install. */
	status?: ReaStatus;
	error?: ReaInstallError;
	/** The tail of npm's output, for the user. */
	detail?: string;
}

/**
 * Whether `version` meets one of the `^x.y.z` / `>=x.y.z` ranges: the same
 * reading as `node_satisfies` in `apps/backend/rea/pin.py` and the release
 * script, `^22.23.4` is 22.x from 22.23.4, `>=26.12.1` anything from there on.
 */
export function nodeSatisfies(version: string, ranges: readonly string[]): boolean {
	const parse = (text: string): number[] | null => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
		return match ? match.slice(1, 4).map(Number) : null;
	};
	const actual = parse(version);
	if (!actual) return false;
	return ranges.some((range) => {
		const match = /^(\^|>=)(\d+\.\d+\.\d+)$/.exec(range);
		const minimum = match ? parse(match[2]) : null;
		if (!match || !minimum) return false;
		if (match[1] === "^" && actual[0] !== minimum[0]) return false;
		for (let i = 0; i < 3; i++) {
			if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
		}
		return true;
	});
}
