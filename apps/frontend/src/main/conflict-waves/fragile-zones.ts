/**
 * Fragile zones (#358, lot 2): files the project's history changes together.
 * Two specs that touch two such files (one each) often meet in a merge even
 * without a file in common: an interface and its implementation, a schema and
 * its migration, a component and its styles. Language-agnostic: only paths
 * and the commits that changed them count.
 *
 * Read with git by argument list (no shell), bounded: the last
 * `FRAGILE_COMMITS` commits without merges, sweeping commits (more than
 * `MAX_FILES_PER_COMMIT` files: a reformat, a rename) left out, one timeout,
 * one output cap. A pair of files is coupled once it changed together
 * `MIN_CO_CHANGES` times; the scorer (`fragileLinks`) adds them to the score.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getToolPath } from "../cli-tool-manager";
import { normalizePlanPath } from "../utils/plan-conflicts";
import type { CoChangeIndex } from "./scorer";

const execFileAsync = promisify(execFile);

export const FRAGILE_COMMITS = 300;
export const MIN_CO_CHANGES = 3;
export const MAX_FILES_PER_COMMIT = 20;
const GIT_TIMEOUT_MS = 10_000;

export interface CoChanges {
	index: CoChangeIndex;
	/** Commits read. */
	commits: number;
}

export function buildCoChangeIndex(commits: ReadonlyArray<readonly string[]>): CoChangeIndex {
	const counts = new Map<string, number>();
	for (const files of commits) {
		const unique = [...new Set(files.map(normalizePlanPath).filter(Boolean))].sort();
		if (unique.length < 2 || unique.length > MAX_FILES_PER_COMMIT) continue;
		for (let i = 0; i < unique.length; i++) {
			for (let j = i + 1; j < unique.length; j++) {
				const key = `${unique[i]}\u0000${unique[j]}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
	}
	const index = new Map<string, Set<string>>();
	const link = (x: string, y: string) => {
		const partners = index.get(x) ?? new Set<string>();
		partners.add(y);
		index.set(x, partners);
	};
	for (const [key, count] of counts) {
		if (count < MIN_CO_CHANGES) continue;
		const [x, y] = key.split("\u0000");
		link(x, y);
		link(y, x);
	}
	return index;
}

/** `\x1e` opens each commit, `\0` ends each path: what `--format=%x1e -z` prints. */
export function parseLog(stdout: string): string[][] {
	return stdout
		.split("\u001e")
		.slice(1)
		.map((chunk) =>
			chunk
				.split("\0")
				.map((file) => file.replace(/^\n+/, ""))
				.filter(Boolean),
		);
}

export async function readCoChanges(projectPath: string): Promise<CoChanges | null> {
	try {
		const { stdout } = await execFileAsync(
			getToolPath("git"),
			[
				"log",
				`--max-count=${FRAGILE_COMMITS}`,
				"--no-merges",
				"--no-renames",
				"--name-only",
				"-z",
				"--format=%x1e",
				"HEAD",
				"--",
			],
			{ cwd: projectPath, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf-8" },
		);
		const commits = parseLog(stdout);
		return { index: buildCoChangeIndex(commits), commits: commits.length };
	} catch {
		return null;
	}
}
