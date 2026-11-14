/**
 * Where nvm, fnm, Volta, mise and asdf keep their Node.js releases: the same
 * layouts as `apps/backend/rea/node_installs.py` (one JSON, kept equal).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedNodeInstalls, npmCliBeside, parseNodeVersion } from "./node-installs";

let home: string;

function binary(relative: string): string {
	const file = path.join(home, ...relative.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "", "utf-8");
	return file;
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "node-installs-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe("parseNodeVersion", () => {
	it("reads a prerelease as its release", () => {
		expect(parseNodeVersion("v27.0.0-alpha.0.1.0")).toEqual([27, 0, 0]);
		expect(parseNodeVersion("26.10.0\n")).toEqual([26, 10, 0]);
		expect(parseNodeVersion("default")).toBeNull();
	});
});

describe("managedNodeInstalls", () => {
	it("reads every POSIX manager, newest first", () => {
		const nvmOld = binary(".nvm/versions/node/v26.10.0/bin/node");
		const nvmNew = binary(".nvm/versions/node/v27.0.0-alpha.0.1.0/bin/node");
		const fnm = binary(".local/share/fnm/node-versions/v24.22.1/installation/bin/node");
		const volta = binary(".volta/tools/image/node/22.23.4/bin/node");
		const mise = binary(".local/share/mise/installs/node/26.12.1/bin/node");
		const asdf = binary(".asdf/installs/nodejs/20.0.0/bin/node");
		fs.mkdirSync(path.join(home, ".nvm/versions/node/not-a-version"), { recursive: true });
		fs.mkdirSync(path.join(home, ".nvm/versions/node/v25.0.0"), { recursive: true });

		const found = managedNodeInstalls({ home, env: {}, windows: false });

		expect(found.map((i) => i.path)).toEqual([nvmNew, mise, nvmOld, fnm, volta, asdf]);
		expect(found.map((i) => i.manager)).toEqual(["nvm", "mise", "nvm", "fnm", "volta", "asdf"]);
	});

	it("follows a manager's variable only when it is absolute", () => {
		const custom = path.join(home, "elsewhere");
		const node = path.join(custom, "versions", "node", "v26.12.1", "bin", "node");
		fs.mkdirSync(path.dirname(node), { recursive: true });
		fs.writeFileSync(node, "", "utf-8");
		expect(
			managedNodeInstalls({ home: path.join(home, "h"), env: { NVM_DIR: custom }, windows: false }),
		).toEqual([{ path: node, version: [26, 12, 1], manager: "nvm" }]);
		expect(
			managedNodeInstalls({ home: path.join(home, "h"), env: { NVM_DIR: "versions" }, windows: false }),
		).toEqual([]);
	});

	it("reads the Windows managers", () => {
		const nvm = binary("AppData/Roaming/nvm/v26.12.1/node.exe");
		const fnm = binary("AppData/Roaming/fnm/node-versions/v24.22.1/installation/node.exe");
		const volta = binary("AppData/Local/Volta/tools/image/node/22.23.4/node.exe");
		const found = managedNodeInstalls({ home, env: {}, windows: true });
		expect(found.map((i) => i.path)).toEqual([nvm, fnm, volta]);
	});
});

describe("npmCliBeside", () => {
	it("finds npm in the Windows layout, then the POSIX one", () => {
		const windows = binary("win/node_modules/npm/bin/npm-cli.js");
		expect(npmCliBeside(path.join(home, "win", "node.exe"))).toBe(windows);
		const posix = binary("posix/lib/node_modules/npm/bin/npm-cli.js");
		expect(npmCliBeside(path.join(home, "posix", "bin", "node"))).toBe(posix);
		expect(npmCliBeside(path.join(home, "nowhere", "node"))).toBeNull();
	});
});
