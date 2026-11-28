import type { ServerClient } from "../api/client";
import { api } from "../api/endpoints";

/** Routes the screens reach only through push or edit flows: their method, path and body are the contract. */
function recorder() {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const client = {
		request: jest.fn(async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			return {};
		}),
	} as unknown as ServerClient;
	return { calls, routes: api(client) };
}

describe("server routes", () => {
	it("lists, resumes and sets aside the runs a server restart interrupted", async () => {
		const client = {
			request: jest.fn(async (method: string, path: string, body?: unknown) =>
				method === "GET" ? { runs: [{ run_id: "r1" }] } : { method, path, body },
			),
		} as unknown as ServerClient;
		const routes = api(client);
		expect(await routes.interruptedRuns()).toEqual([{ run_id: "r1" }]);
		await routes.resumeRun("p 1", "s1", "r/1");
		await routes.setInterruptedRunsAside(["r1", "r2"]);
		expect((client.request as jest.Mock).mock.calls).toEqual([
			["GET", "/users/me/interrupted-runs"],
			["POST", "/projects/p%201/specs/s1/runs/r%2F1/resume"],
			["POST", "/users/me/interrupted-runs/later", { run_ids: ["r1", "r2"] }],
		]);
	});

	it("registers and forgets this phone for push", async () => {
		const { calls, routes } = recorder();
		await routes.registerDevice("tok", "android", "fr");
		await routes.unregisterDevice("tok");
		expect(calls).toEqual([
			{ method: "PUT", path: "/users/me/devices", body: { token: "tok", platform: "android", locale: "fr" } },
			{ method: "DELETE", path: "/users/me/devices", body: { token: "tok" } },
		]);
	});

	it("reads and sets a card's criticality, and lends and ends an approval", async () => {
		const { calls, routes } = recorder();
		await routes.approvals("p1", "004-x");
		await routes.setCriticality("p1", "004-x", "high");
		await routes.delegations("p 1");
		await routes.lendApproval("p1", "u2", "2026-12-01T00:00:00.000Z");
		await routes.endDelegation("p1", "d/1");
		await routes.members("p1");
		expect(calls).toEqual([
			{ method: "GET", path: "/api/board/cards/004-x/approvals?project_id=p1", body: undefined },
			{ method: "PUT", path: "/api/board/cards/004-x/criticality?project_id=p1", body: { criticality: "high" } },
			{ method: "GET", path: "/api/board/delegations?project_id=p%201", body: undefined },
			{
				method: "POST",
				path: "/api/board/delegations?project_id=p1",
				body: { to_user_id: "u2", ends_at: "2026-12-01T00:00:00.000Z" },
			},
			{ method: "DELETE", path: "/api/board/delegations/d%2F1?project_id=p1", body: undefined },
			{ method: "GET", path: "/projects/p1/members", body: undefined },
		]);
	});

	it("steers a card from the phone and reads back its messages", async () => {
		const client = {
			request: jest.fn(async () => ({ messages: [{ id: "m1" }] })),
		} as unknown as ServerClient & { request: jest.Mock };
		await expect(api(client).steer("p1", "004-x", "Keep the route")).resolves.toEqual([{ id: "m1" }]);
		expect(client.request).toHaveBeenCalledWith("POST", "/api/board/cards/004-x/steering?project_id=p1", {
			text: "Keep the route",
			source: "mobile",
		});
	});

	it("creates a card with its settings and pictures only when it has some", async () => {
		const { calls, routes } = recorder();
		const base = { title: "T", description: "D", requireReview: true };
		await routes.createCard("p1", base);
		await routes.createCard("p1", {
			...base,
			kind: "bug_fix",
			settings: { priority: "high" } as never,
			attachments: [{ filename: "a.png", mimeType: "image/png", data: "iVBO" }],
		});
		await routes.createCard("p1", { ...base, attachments: [] });
		expect(calls.map((c) => c.body)).toEqual([
			{ title: "T", description: "D", kind: null, require_review: true },
			{
				title: "T",
				description: "D",
				kind: "bug_fix",
				require_review: true,
				settings: { priority: "high" },
				attachments: [{ filename: "a.png", mimeType: "image/png", data: "iVBO" }],
			},
			{ title: "T", description: "D", kind: null, require_review: true },
		]);
	});

	it("starts a feature job with no options and reads its output from the start by default", async () => {
		const { calls, routes } = recorder();
		await routes.startFeatureJob("roadmap", "p1");
		await routes.featureJob("roadmap", "p1", "j 1");
		expect(calls).toEqual([
			{ method: "POST", path: "/api/features/roadmap/jobs?project_id=p1", body: {} },
			{ method: "GET", path: "/api/features/roadmap/jobs/j%201?project_id=p1&after=0", body: undefined },
		]);
	});

	it("edits a card by project id, never by path", async () => {
		const { calls, routes } = recorder();
		await routes.updateCard("p 1", "007/x", { title: "New" });
		expect(calls[0]).toEqual({
			method: "PATCH",
			path: "/api/board/cards/007%2Fx?project_id=p%201",
			body: { title: "New" },
		});
	});

	it("saves only the theme fields of the preferences", async () => {
		const { calls, routes } = recorder();
		await routes.setPreferences({ theme: "dark", colorTheme: "ocean", extra: 1 } as never);
		expect(calls[0]).toEqual({ method: "PUT", path: "/users/me/preferences", body: { theme: "dark", colorTheme: "ocean" } });
	});
});
