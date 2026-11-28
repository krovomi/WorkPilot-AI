import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	isServerMode: vi.fn(() => true),
	getServerProject: vi.fn((id: unknown) => (id === "p-1" ? { id: "p-1" } : undefined)),
}));

vi.mock("../server-connection", () => ({
	authedFetch: deps.authedFetch,
	isServerMode: deps.isServerMode,
}));
vi.mock("../server-projects", () => ({ getServerProject: deps.getServerProject }));

import { deleteMcpReview, listMcpReviews, putMcpReview, toReview } from "../mcp-reviews";

const ID = "0123abcd-0000-4000-8000-0123456789ab";
const RAW = {
	id: ID,
	server_id: "github",
	verdict: "caution",
	comment: "Calls an undocumented host.",
	author: "Ada",
	updated_at: "2026-11-22T10:00:00+00:00",
	mine: true,
	can_delete: true,
};

beforeEach(() => {
	deps.authedFetch.mockReset();
	deps.isServerMode.mockReturnValue(true);
});

describe("toReview", () => {
	it("reads a review field by field", () => {
		expect(toReview(RAW)).toEqual({
			id: ID,
			serverId: "github",
			verdict: "caution",
			comment: "Calls an undocumented host.",
			author: "Ada",
			updatedAt: "2026-11-22T10:00:00+00:00",
			mine: true,
			canDelete: true,
		});
	});

	it("defaults what is missing and caps what is long", () => {
		const review = toReview({
			id: ID,
			server_id: "github",
			verdict: "safe",
			comment: "x".repeat(2000),
			author: 7,
			mine: "yes",
		});
		expect(review?.comment).toHaveLength(1000);
		expect(review?.author).toBe("");
		expect(review?.updatedAt).toBeNull();
		expect(review?.mine).toBe(false);
		expect(review?.canDelete).toBe(false);
		expect(toReview({ ...RAW, comment: null })?.comment).toBe("");
	});

	it.each([
		null,
		[],
		"review",
		{ ...RAW, id: "../x" },
		{ ...RAW, id: 3 },
		{ ...RAW, server_id: "../etc" },
		{ ...RAW, server_id: undefined },
		{ ...RAW, verdict: "great" },
		{ ...RAW, verdict: 1 },
	])("refuses what is not a review: %j", (raw) => {
		expect(toReview(raw)).toBeNull();
	});
});

describe("listMcpReviews", () => {
	it("asks the server for the organization's reviews of one server, from a project", async () => {
		deps.authedFetch.mockResolvedValue({
			ok: true,
			data: { reviews: [RAW, { id: "bad" }], can_write: true },
		});
		const answer = await listMcpReviews({ projectId: "p-1", serverId: "github" });
		expect(deps.authedFetch).toHaveBeenCalledWith(
			"/api/features/mcp-reviews?project_id=p-1&server_id=github",
			"GET",
		);
		expect(answer).toEqual({
			success: true,
			data: { reviews: [toReview(RAW)], canWrite: true },
		});
	});

	it.each([
		[{ reviews: [] }, false],
		[{ reviews: [], can_write: "yes" }, false],
		[{ reviews: [], can_write: 1 }, false],
	])("writes only when the server says so exactly: %j", async (data, canWrite) => {
		deps.authedFetch.mockResolvedValue({ ok: true, data });
		const answer = await listMcpReviews({ projectId: "p-1", serverId: "github" });
		expect(answer).toEqual({ success: true, data: { reviews: [], canWrite } });
	});

	it("refuses before any request", async () => {
		expect(await listMcpReviews(null)).toEqual({ success: false, error: "Invalid request" });
		expect(await listMcpReviews({ projectId: "local", serverId: "github" })).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		expect(await listMcpReviews({ projectId: "p-1", serverId: "../x" })).toEqual({
			success: false,
			error: "Invalid server id",
		});
		deps.isServerMode.mockReturnValue(false);
		expect(await listMcpReviews({ projectId: "p-1", serverId: "github" })).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		expect(deps.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on a refusal and a malformed answer", async () => {
		deps.authedFetch.mockResolvedValueOnce({ ok: false, error: "Forbidden" });
		expect(await listMcpReviews({ projectId: "p-1", serverId: "github" })).toEqual({
			success: false,
			error: "Forbidden",
		});
		deps.authedFetch.mockResolvedValueOnce({ ok: true, data: { reviews: "no" } });
		expect(await listMcpReviews({ projectId: "p-1", serverId: "github" })).toEqual({
			success: false,
			error: "bad_reviews",
		});
		deps.authedFetch.mockResolvedValueOnce({ ok: true, data: null });
		expect((await listMcpReviews({ projectId: "p-1", serverId: "github" })).success).toBe(
			false,
		);
	});
});

describe("putMcpReview", () => {
	const request = { projectId: "p-1", serverId: "github", verdict: "caution", comment: "ok" };

	it("sends the review and reads back the stored one", async () => {
		deps.authedFetch.mockResolvedValue({ ok: true, data: { review: RAW } });
		expect(await putMcpReview(request)).toEqual({ success: true, data: toReview(RAW) });
		expect(deps.authedFetch).toHaveBeenCalledWith(
			"/api/features/mcp-reviews?project_id=p-1",
			"PUT",
			{ server_id: "github", verdict: "caution", comment: "ok" },
		);
	});

	it.each([
		[null, "Invalid request"],
		[{ ...request, projectId: "local" }, "not_a_server_project"],
		[{ ...request, serverId: "" }, "Invalid server id"],
		[{ ...request, verdict: "great" }, "Invalid verdict"],
		[{ ...request, verdict: undefined }, "Invalid verdict"],
		[{ ...request, comment: 3 }, "Invalid comment"],
		[{ ...request, comment: "x".repeat(1001) }, "Invalid comment"],
	])("refuses %j before any request", async (bad, error) => {
		expect(await putMcpReview(bad)).toEqual({ success: false, error });
		expect(deps.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on a refusal and a malformed answer", async () => {
		deps.authedFetch.mockResolvedValueOnce({ ok: false, error: "too_many_reviews" });
		expect(await putMcpReview(request)).toEqual({ success: false, error: "too_many_reviews" });
		deps.authedFetch.mockResolvedValueOnce({ ok: true, data: { review: { id: "x" } } });
		expect(await putMcpReview(request)).toEqual({ success: false, error: "bad_reviews" });
		deps.authedFetch.mockResolvedValueOnce({ ok: true, data: [] });
		expect(await putMcpReview(request)).toEqual({ success: false, error: "bad_reviews" });
	});
});

describe("deleteMcpReview", () => {
	it("deletes a review by id", async () => {
		deps.authedFetch.mockResolvedValue({ ok: true, data: { deleted: true } });
		expect(await deleteMcpReview({ projectId: "p-1", reviewId: ID })).toEqual({
			success: true,
			data: true,
		});
		expect(deps.authedFetch).toHaveBeenCalledWith(
			`/api/features/mcp-reviews/${ID}?project_id=p-1`,
			"DELETE",
		);
	});

	it("refuses a bad id or project, and passes on a refusal", async () => {
		expect(await deleteMcpReview(undefined)).toEqual({ success: false, error: "Invalid request" });
		expect(await deleteMcpReview({ projectId: "x", reviewId: ID })).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		expect(await deleteMcpReview({ projectId: "p-1", reviewId: "../../admin" })).toEqual({
			success: false,
			error: "Invalid review id",
		});
		expect(deps.authedFetch).not.toHaveBeenCalled();
		deps.authedFetch.mockResolvedValueOnce({ ok: false, error: "review_not_found" });
		expect(await deleteMcpReview({ projectId: "p-1", reviewId: ID })).toEqual({
			success: false,
			error: "review_not_found",
		});
	});
});
