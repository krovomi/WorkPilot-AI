/**
 * Node.js releases a version manager installed but did not put on PATH.
 *
 * nvm, fnm, Volta, mise and asdf choose a Node.js per shell: the one a
 * terminal reports is not necessarily the one WorkPilot inherited. Under WSL,
 * nvm's default alias decides what every new shell (and the app) gets, while
 * `nvm use` in one terminal changes only that terminal. The REA badge looks
 * here when the PATH's Node.js is too old, as `apps/backend/rea/locate.py`
 * does: both read the same layouts (`node-installs.json`, kept equal to the
 * backend's by `tests/rea/test_rea_node_installs.py`). Only directories under
 * the home or a manager's own variable are read; nothing is run here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import layouts from "../shared/constants/node-installs.json";
import { isWindows } from "./platform";

export type NodeVersion = readonly [number, number, number];

export interface NodeInstall {
	path: string;
	/** From the directory name: a hint, checked by running the binary. */
	version: NodeVersion;
	manager: string;
}

interface Layout {
	manager: string;
	env: string;
	homes: string[];
	versions: string;
	bin: string;
}

/** Directories read per manager: a version list, not a tree to walk. */
const MAX_ENTRIES = 64;

/** `v27.0.0-alpha.1` reads as 27.0.0, as npm reads `engines`. */
export function parseNodeVersion(text: string): NodeVersion | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: NodeVersion, b: NodeVersion): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function roots(layout: Layout, home: string, env: Record<string, string | undefined>): string[] {
	const found: string[] = [];
	const override = env[layout.env];
	if (override && path.isAbsolute(override)) found.push(override);
	for (const relative of layout.homes) found.push(path.join(home, ...relative.split("/")));
	return found;
}

/** Every Node.js the known managers hold here, newest first. */
export function managedNodeInstalls(
	options: {
		home?: string;
		env?: Record<string, string | undefined>;
		windows?: boolean;
	} = {},
): NodeInstall[] {
	const home = options.home ?? os.homedir();
	const env = options.env ?? process.env;
	const windows = options.windows ?? isWindows();
	const list: Layout[] = windows ? layouts.windows : layouts.posix;
	const found: NodeInstall[] = [];
	const seen = new Set<string>();
	for (const layout of list) {
		for (const root of roots(layout, home, env)) {
			const base = layout.versions ? path.join(root, ...layout.versions.split("/")) : root;
			let entries: string[];
			try {
				entries = fs.readdirSync(base).sort().slice(0, MAX_ENTRIES);
			} catch {
				continue;
			}
			for (const entry of entries) {
				const version = parseNodeVersion(entry);
				if (!version) continue;
				const binary = path.join(base, entry, ...layout.bin.split("/"));
				const key = windows ? binary.toLowerCase() : binary;
				if (seen.has(key) || !isFile(binary)) continue;
				seen.add(key);
				found.push({ path: binary, version, manager: layout.manager });
			}
		}
	}
	return found.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * npm's `npm-cli.js` next to a Node.js binary (Windows layout, then POSIX),
 * so a release that is not on PATH installs into its own prefix.
 */
export function npmCliBeside(node: string): string | null {
	const base = path.dirname(node);
	for (const candidate of [
		path.join(base, "node_modules", "npm", "bin", "npm-cli.js"),
		path.join(path.dirname(base), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	]) {
		if (isFile(candidate)) return candidate;
	}
	return null;
}
