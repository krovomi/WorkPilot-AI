/**
 * Reads a project's MCP install policy, `.workpilot/mcp-policy.json` (#369).
 *
 * The path is resolved (links included) and must stay inside the project's
 * own folder (S4): a `.workpilot` or a policy file that links elsewhere is
 * not read, and counts as an invalid policy. The file is opened once, then
 * checked to be a regular file under 64 KB before it is read from the same
 * descriptor. No file: no policy. Anything wrong with the file: the strictest
 * policy, marked invalid — never ignored in silence. Schema:
 * `shared/mcp-catalog/install-policy.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { invalidPolicy, parseMcpPolicy } from "../../shared/mcp-catalog/install-policy";
import type { McpPolicyState } from "../../shared/types/mcp-policy";
import { isWithinRoot } from "../security/renderer-path";

export const POLICY_FILE = path.join(".workpilot", "mcp-policy.json");
export const MAX_POLICY_BYTES = 64 * 1024;

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function readMcpPolicy(projectPath: string): McpPolicyState {
	const candidate = path.join(projectPath, POLICY_FILE);
	try {
		fs.lstatSync(candidate);
	} catch (error) {
		return missing(error) ? { state: "none" } : invalidPolicy("unreadable");
	}
	let root: string;
	let real: string;
	try {
		root = fs.realpathSync(projectPath);
		real = fs.realpathSync(candidate);
	} catch {
		return invalidPolicy("unreadable");
	}
	if (!isWithinRoot(real, root)) return invalidPolicy("outsideProject");

	let fd: number | undefined;
	try {
		fd = fs.openSync(real, "r");
		const stats = fs.fstatSync(fd);
		if (!stats.isFile()) return invalidPolicy("notAFile");
		if (stats.size > MAX_POLICY_BYTES) return invalidPolicy("tooLarge");
		const buffer = Buffer.alloc(stats.size);
		const read = fs.readSync(fd, buffer, 0, stats.size, 0);
		return parseMcpPolicy(buffer.subarray(0, read).toString("utf-8"));
	} catch {
		return invalidPolicy("unreadable");
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
