/**
 * `test_placement.json`, written by the build in the task's spec folder
 * (`apps/backend/test_placement/prepare.py`). It comes from a process that
 * ran the task's code, so it is validated here and only read, never acted on
 * beyond its target: closed lists, bounded numbers.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SuitePlacement } from "../../shared/types/suite-placement";

export const PLACEMENT_FILE = "test_placement.json";

const Schema = z.object({
	target: z.enum(["machine", "server", "ci", "queue"]),
	reason: z.enum([
		"chosen",
		"alone",
		"room",
		"pr",
		"server",
		"branch_push",
		"no_route",
		"turn",
		"not_followed",
	]),
	mode: z.enum(["auto", "machine", "ci"]),
	short: z.array(z.enum(["cpu", "ram", "vram"])).max(3).default([]),
	decidedBy: z.enum(["task", "project", "default"]).optional(),
	waitedSeconds: z.number().min(0).max(1e9).optional(),
	at: z.number().int().min(0).max(1e11).optional(),
	facts: z
		.record(z.string().max(40), z.number().finite())
		.refine((facts) => Object.keys(facts).length <= 32)
		.default({}),
});

/** The parsed decision, or null when absent or not what the build writes. */
export function parseSuitePlacement(raw: unknown): SuitePlacement | null {
	const parsed = Schema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export function readSuitePlacement(specDir: string): SuitePlacement | null {
	const file = path.join(specDir, PLACEMENT_FILE);
	if (!existsSync(file)) return null;
	try {
		return parseSuitePlacement(JSON.parse(readFileSync(file, "utf-8")));
	} catch {
		return null;
	}
}
