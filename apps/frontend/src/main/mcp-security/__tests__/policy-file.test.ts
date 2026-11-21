/**
 * @vitest-environment node
 *
 * The policy file is read from the project's own folder only: a file or a
 * `.workpilot` that links elsewhere, a folder, a file too large or that
 * cannot be read is the strictest policy, said invalid — never ignored.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../project-store", () => ({ projectStore: { getProjects: () => [] } }));

/** A failure the next calls of one fs function make, in place of the disk. */
const fault = vi.hoisted(() => ({} as Record<string, ((...args: unknown[]) => unknown) | undefined>));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const wrap =
		(name: "realpathSync" | "lstatSync" | "readSync" | "openSync") =>
		(...args: unknown[]) =>
			fault[name]
				? fault[name]?.(...args)
				: (actual[name] as (...a: unknown[]) => unknown)(...args);
	return {
		...actual,
		realpathSync: wrap("realpathSync"),
		lstatSync: wrap("lstatSync"),
		readSync: wrap("readSync"),
		openSync: wrap("openSync"),
	};
});

import { STRICTEST_POLICY } from "../../../shared/mcp-catalog/install-policy";
import { MAX_POLICY_BYTES, readMcpPolicy } from "../policy-file";

let root: string;
let project: string;

const write = (text: string) => {
	fs.mkdirSync(path.join(project, ".workpilot"), { recursive: true });
	fs.writeFileSync(path.join(project, ".workpilot", "mcp-policy.json"), text);
};
const invalid = (reason: string) => ({ state: "invalid", reason, policy: STRICTEST_POLICY });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-policy-"));
	project = path.join(root, "project");
	fs.mkdirSync(project);
});

afterEach(() => {
	for (const key of Object.keys(fault)) fault[key] = undefined;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("readMcpPolicy", () => {
	it("is no policy without the file", () => {
		expect(readMcpPolicy(project)).toEqual({ state: "none" });
	});

	it("reads the project's policy", () => {
		write(JSON.stringify({ allowedServers: ["github"], blockCustomServers: true }));
		expect(readMcpPolicy(project)).toEqual({
			state: "active",
			policy: { allowedServers: ["github"], blockCustomServers: true },
		});
	});

	it("says a file that is not a policy is invalid", () => {
		write("{ nope");
		expect(readMcpPolicy(project)).toEqual(invalid("notJson"));
	});

	it("refuses a file too large", () => {
		write(" ".repeat(MAX_POLICY_BYTES + 1));
		expect(readMcpPolicy(project)).toEqual(invalid("tooLarge"));
	});

	it("refuses a folder in place of the file", () => {
		fs.mkdirSync(path.join(project, ".workpilot", "mcp-policy.json"), { recursive: true });
		expect(readMcpPolicy(project)).toEqual(invalid("notAFile"));
	});

	it("refuses a file that resolves outside the project", async () => {
		write("{}");
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		fault.realpathSync = (p) =>
			String(p).endsWith("mcp-policy.json")
				? path.join(root, "outside.json")
				: actual.realpathSync(p as string);
		expect(readMcpPolicy(project)).toEqual(invalid("outsideProject"));
	});

	it("says a link to nowhere is unreadable, not absent", () => {
		write("{}");
		fault.realpathSync = () => {
			throw Object.assign(new Error("gone"), { code: "ENOENT" });
		};
		expect(readMcpPolicy(project)).toEqual(invalid("unreadable"));
	});

	it("says a file it cannot look at or read is unreadable", () => {
		write("{}");
		fault.lstatSync = () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		};
		expect(readMcpPolicy(project)).toEqual(invalid("unreadable"));
		fault.lstatSync = undefined;
		fault.readSync = () => {
			throw new Error("EIO");
		};
		expect(readMcpPolicy(project)).toEqual(invalid("unreadable"));
		fault.readSync = undefined;
		fault.openSync = () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		};
		expect(readMcpPolicy(project)).toEqual(invalid("unreadable"));
	});
});
