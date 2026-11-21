/**
 * A server project's review feedback (#361, lot 3): the app sends a project
 * id and checked fields to the server's routes, never a path, and keeps of
 * the answers only what has the shape of one before the view sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock("../../../server-connection", () => ({ authedFetch }));
vi.mock("../utils/subprocess-runner", () => ({ getBackendPath: () => null }));
vi.mock("../../../source-env", () => ({ loadBackendEnv: () => ({}) }));

import type { Project } from "../../../../shared/types";
import { signature } from "../review-feedback-dataset";
import {
	decideServerHeld,
	recordServerFeedback,
	resetServerRule,
	serverFeedback,
	serverFeedbackStats,
} from "../review-feedback-server";

const PROJECT = { id: "p 1", remote: true } as unknown as Project;
const ROUTE = "/api/features/forge/github/reviews";
const Q = "project_id=p%201";

function record(i: number, extra: Record<string, unknown> = {}) {
	return {
		v: 1,
		at: "2026-11-21T00:00:00+00:00",
		pr: 10 + i,
		finding_id: `f${i}`,
		verdict: "rejected",
		reason: "too_pedantic",
		note: "",
		category: "style",
		severity: "low",
		title: `Nit on \`x${i}\``,
		...extra,
	};
}

beforeEach(() => {
	authedFetch.mockReset();
});

describe("one PR", () => {
	it("reads its verdicts and held findings, dropping what is not one", async () => {
		authedFetch.mockResolvedValueOnce({
			ok: true,
			data: {
				feedback: { "f-1": "rejected", "f-2": "accepted", "../x": "rejected", "f-3": "maybe" },
				held: ["f-1", "../x", 7, "f-9"],
			},
		});

		await expect(serverFeedback(PROJECT, 5)).resolves.toEqual({
			success: true,
			feedback: { "f-1": "rejected", "f-2": "accepted" },
			held: ["f-1"],
		});
		expect(authedFetch).toHaveBeenCalledWith(`${ROUTE}/5/feedback?${Q}`, "GET");
	});

	it("reads an answer of the wrong shape as empty, and a failure as not found", async () => {
		authedFetch.mockResolvedValueOnce({ ok: true, data: ["not", "an object"] });
		await expect(serverFeedback(PROJECT, 5)).resolves.toEqual({
			success: true,
			feedback: {},
			held: [],
		});
		authedFetch.mockResolvedValueOnce({ ok: false, error: "HTTP 500" });
		await expect(serverFeedback(PROJECT, 5)).resolves.toEqual({
			success: false,
			error: "not_found",
		});
	});

	it("sends a verdict as the server's fields, and a failure is a failed write", async () => {
		authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { feedback: { "f-1": "rejected" }, held: ["f-1"] },
		});
		const feedback = {
			prNumber: 5,
			findingId: "f-1",
			verdict: "rejected" as const,
			reason: "other" as const,
			note: "why",
		};

		await expect(recordServerFeedback(PROJECT, feedback)).resolves.toEqual({
			success: true,
			feedback: { "f-1": "rejected" },
			held: ["f-1"],
		});
		expect(authedFetch).toHaveBeenCalledWith(`${ROUTE}/5/feedback?${Q}`, "POST", {
			finding_id: "f-1",
			verdict: "rejected",
			reason: "other",
			note: "why",
		});
		authedFetch.mockResolvedValueOnce({ ok: false, error: "Requires project role 'member'" });
		await expect(recordServerFeedback(PROJECT, feedback)).resolves.toEqual({
			success: false,
			error: "write_failed",
		});
	});
});

describe("the project-wide view", () => {
	const overview = {
		dataset: `${[0, 1].map((i) => JSON.stringify(record(i))).join("\n")}\n`,
		threshold: 2,
		maintainer: true,
		held: [
			record(5, { verdict: "not_applicable", note: " legacy\n\tcode ", reason: null }),
			record(6, { verdict: "accepted" }),
			record(7, { category: "../etc" }),
			"not a record",
			record(8, { note: 3 }),
		],
	};

	it("computes the stats from the server's dataset and keeps the valid held ones", async () => {
		authedFetch.mockResolvedValueOnce({ ok: true, data: overview });

		const result = await serverFeedbackStats(PROJECT);

		expect(authedFetch).toHaveBeenCalledWith(`${ROUTE}/feedback?${Q}`, "GET");
		if (!result.success) throw new Error("expected the stats");
		expect(result.stats.threshold).toBe(2);
		expect(result.stats.rules.map((rule) => rule.signature)).toEqual([
			signature("style", "Nit on `x`"),
		]);
		expect(result.stats.server?.maintainer).toBe(true);
		expect(result.stats.server?.held).toEqual([
			{
				prNumber: 15,
				findingId: "f5",
				verdict: "not_applicable",
				reason: null,
				note: "legacy code",
				category: "style",
				label: "Nit on `x5`",
			},
			expect.objectContaining({ findingId: "f8", note: "" }),
		]);
	});

	it("bounds a long note, and reads an answer of the wrong shape as an empty view", async () => {
		authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { held: [record(1, { note: "n".repeat(400) })] },
		});
		const long = await serverFeedbackStats(PROJECT);
		if (!long.success) throw new Error("expected the stats");
		expect(long.stats.server?.held[0]?.note).toHaveLength(280);

		authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { dataset: 7, threshold: "9; rm -rf /", maintainer: "yes", held: {} },
		});
		await expect(serverFeedbackStats(PROJECT)).resolves.toEqual({
			success: true,
			stats: {
				threshold: 3,
				categories: [],
				rules: [],
				server: { maintainer: false, held: [] },
			},
		});
		authedFetch.mockResolvedValueOnce({ ok: false, error: "HTTP 404" });
		await expect(serverFeedbackStats(PROJECT)).resolves.toEqual({
			success: false,
			error: "not_found",
		});
	});

	it("resets a rule, then reads the view again", async () => {
		authedFetch
			.mockResolvedValueOnce({ ok: true, data: { reset: true } })
			.mockResolvedValueOnce({ ok: true, data: overview });

		const result = await resetServerRule(PROJECT, "0123456789abcdef");

		expect(result.success).toBe(true);
		expect(authedFetch.mock.calls[0]).toEqual([
			`${ROUTE}/feedback/reset?${Q}`,
			"POST",
			{ signature: "0123456789abcdef" },
		]);
		authedFetch.mockResolvedValueOnce({ ok: false, error: "Requires project role 'owner'" });
		await expect(resetServerRule(PROJECT, "0123456789abcdef")).resolves.toEqual({
			success: false,
			error: "write_failed",
		});
	});

	it("decides a held rejection, then reads the view again", async () => {
		authedFetch
			.mockResolvedValueOnce({ ok: true, data: { done: true } })
			.mockResolvedValueOnce({ ok: true, data: overview });

		const result = await decideServerHeld(PROJECT, 15, "f5", false);

		expect(result.success).toBe(true);
		expect(authedFetch.mock.calls[0]).toEqual([
			`${ROUTE}/feedback/held?${Q}`,
			"POST",
			{ pr: 15, finding_id: "f5", approve: false },
		]);
		authedFetch.mockResolvedValueOnce({ ok: false, error: "No such held rejection" });
		await expect(decideServerHeld(PROJECT, 15, "f5", true)).resolves.toEqual({
			success: false,
			error: "write_failed",
		});
	});
});
