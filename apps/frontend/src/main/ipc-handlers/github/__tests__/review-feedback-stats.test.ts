/**
 * The acceptance rate and the learned rules shown for a project (#361, lot 2)
 * follow the backend's rules: downgraded at the threshold, dropped at twice
 * it, security never; the threshold is the one the reviewer runs with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	backendPath: null as string | null,
	values: {} as Record<string, string>,
	fail: false,
}));

vi.mock("../utils/subprocess-runner", () => ({
	getBackendPath: () => env.backendPath,
}));
vi.mock("../../../source-env", () => ({
	loadBackendEnv: () => {
		if (env.fail) throw new Error("keyring locked");
		return env.values;
	},
}));

import { type FeedbackRecord, parseDataset } from "../review-feedback-dataset";
import {
	computeStats,
	configuredThreshold,
	learnedRules,
	THRESHOLD_ENV,
} from "../review-feedback-stats";

function records(
	spec: Array<[string, string, string, number]>,
): FeedbackRecord[] {
	let pr = 0;
	const lines: string[] = [];
	for (const [category, title, verdict, count] of spec) {
		for (let i = 0; i < count; i += 1) {
			pr += 1;
			lines.push(
				JSON.stringify({
					v: 1,
					pr,
					finding_id: `f${pr}`,
					verdict,
					reason: verdict === "accepted" ? null : "too_pedantic",
					category,
					severity: "low",
					title,
				}),
			);
		}
	}
	return parseDataset(lines.join("\n"));
}

beforeEach(() => {
	env.backendPath = null;
	env.values = {};
	env.fail = false;
});

describe("configuredThreshold", () => {
	it("prefers the app's environment, then the backend's .env, then 3", () => {
		env.backendPath = "/backend";
		env.values = { [THRESHOLD_ENV]: "7" };
		expect(configuredThreshold({ [THRESHOLD_ENV]: "4" })).toBe(4);
		expect(configuredThreshold({})).toBe(7);
		env.values = {};
		expect(configuredThreshold({})).toBe(3);
	});

	it("falls back to the default without a backend or when its .env cannot be read", () => {
		expect(configuredThreshold({})).toBe(3);
		env.backendPath = "/backend";
		env.fail = true;
		expect(configuredThreshold({})).toBe(3);
	});

	it("reads the process environment by default", () => {
		vi.stubEnv(THRESHOLD_ENV, "9");
		try {
			expect(configuredThreshold()).toBe(9);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("computeStats", () => {
	it("counts per category, the busiest first", () => {
		const stats = computeStats(
			records([
				["style", "Missing docstring on `a`", "rejected", 2],
				["style", "Missing docstring on `a`", "accepted", 1],
				["style", "Line too long", "not_applicable", 1],
				["quality", "Possible None dereference", "accepted", 1],
				["docs", "Typo", "accepted", 1],
			]),
			3,
		);
		expect(stats.threshold).toBe(3);
		expect(stats.categories).toEqual([
			{ category: "style", accepted: 1, rejected: 2, notApplicable: 1 },
			{ category: "docs", accepted: 1, rejected: 0, notApplicable: 0 },
			{ category: "quality", accepted: 1, rejected: 0, notApplicable: 0 },
		]);
		expect(stats.rules).toEqual([]);
	});
});

describe("learnedRules", () => {
	it("downgrades at the threshold and drops at twice it, the most rejected first", () => {
		const rules = learnedRules(
			records([
				["style", "Missing docstring on `a`", "rejected", 3],
				["quality", "Prefer an early return", "rejected", 7],
				["quality", "Prefer an early return", "accepted", 1],
				["style", "Line too long", "rejected", 2],
				["security", "Hardcoded credential", "rejected", 9],
			]),
			3,
		);
		expect(rules.map((rule) => [rule.category, rule.status])).toEqual([
			["quality", "dropped"],
			["style", "downgraded"],
		]);
		expect(rules[0]).toMatchObject({
			label: "Prefer an early return",
			rejections: 7,
			accepts: 1,
			topReason: "too_pedantic",
		});
	});

	it("orders rules of equal weight by signature", () => {
		const rules = learnedRules(
			records([
				["style", "First kind", "rejected", 3],
				["style", "Second kind", "rejected", 3],
				["style", "Third kind", "rejected", 3],
			]),
			3,
		);
		const signatures = rules.map((rule) => rule.signature);
		expect(signatures).toEqual([...signatures].sort());
	});
});
