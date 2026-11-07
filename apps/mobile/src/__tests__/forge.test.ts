import { ApiError, ServerClient } from "../api/client";
import { makeForge, readReview, repoPath } from "../forge/forge";

type Handler = (body: { method: string; endpoint: string; body?: unknown }, url: string) => unknown;

async function forgeWith(kind: "github" | "gitlab", repoUrl: string, handler: Handler) {
	const sent: { url: string; body: { method: string; endpoint: string; body?: unknown } }[] = [];
	const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/auth/login")) {
			const user = { id: "u", email: "a@x", display_name: "A", role: "member" };
			return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 900, user }));
		}
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		sent.push({ url, body });
		return new Response(JSON.stringify(handler(body, url)));
	}) as unknown as typeof fetch;
	const client = new ServerClient({ baseUrl: "https://wp.example.com", fetchImpl });
	await client.login("a@x", "pw");
	const forge = makeForge(client, "p1", kind, repoUrl);
	if (!forge) throw new Error("no forge");
	return { forge, sent };
}

describe("repoPath", () => {
	it.each([
		["https://github.com/acme/app.git", "acme/app"],
		["git@github.com:acme/app.git", "acme/app"],
		["ssh://git@gitlab.example.com:2222/group/sub/app", "group/sub/app"],
		["https://gitlab.com/group/app/", "group/app"],
	])("reads %s", (url, path) => {
		expect(repoPath(url)).toBe(path);
	});

	it.each(["https://github.com/acme", "https://github.com/acme/../x", "nope"])("refuses %s", (url) => {
		expect(repoPath(url)).toBeNull();
	});
});

describe("GitHub", () => {
	it("lists issues without the pull requests, through the read relay", async () => {
		const { forge, sent } = await forgeWith("github", "https://github.com/acme/app", () => ({
			status: 200,
			body: [
				{ number: 3, title: "Bug", user: { login: "ada" }, state: "open" },
				{ number: 4, title: "A PR", pull_request: {}, state: "open" },
			],
		}));
		const issues = await forge.issues();
		expect(issues.map((i) => [i.number, i.author])).toEqual([[3, "ada"]]);
		expect(sent[0].url).toBe("https://wp.example.com/api/features/forge/github/read?project_id=p1");
		expect(sent[0].body).toEqual({ method: "GET", endpoint: "/repos/acme/app/issues?state=open&per_page=50" });
	});

	it("comments and merges through the write relay", async () => {
		const { forge, sent } = await forgeWith("github", "https://github.com/acme/app", () => ({ status: 201, body: {} }));
		await forge.commentPull(7, "LGTM");
		await forge.merge(7);
		expect(sent.map((s) => [s.url.split("?")[0].split("/").pop(), s.body.method, s.body.endpoint])).toEqual([
			["write", "POST", "/repos/acme/app/issues/7/comments"],
			["write", "PUT", "/repos/acme/app/pulls/7/merge"],
		]);
	});

	it("raises GitHub's own refusal", async () => {
		const { forge } = await forgeWith("github", "https://github.com/acme/app", () => ({
			status: 405,
			body: { message: "Pull Request is not mergeable" },
		}));
		await expect(forge.merge(7)).rejects.toEqual(new ApiError(405, "Pull Request is not mergeable"));
	});

	it("sums up a commit's checks", async () => {
		const { forge } = await forgeWith("github", "https://github.com/acme/app", () => ({
			status: 200,
			body: {
				check_runs: [
					{ status: "completed", conclusion: "success" },
					{ status: "completed", conclusion: "failure" },
					{ status: "in_progress", conclusion: null },
					{ status: "completed", conclusion: "skipped" },
				],
			},
		}));
		await expect(forge.checks("abcdef1")).resolves.toEqual({ passed: 2, failed: 1, pending: 1 });
		await expect(forge.checks("not-a-sha")).resolves.toBeNull();
	});

	it("reads the open pull requests from the GraphQL route", async () => {
		const { forge, sent } = await forgeWith("github", "https://github.com/acme/app", () => ({
			status: 200,
			body: {
				data: {
					repository: {
						pullRequests: {
							nodes: [{ number: 9, title: "Feat", state: "OPEN", author: { login: "bo" }, headRefName: "f", baseRefName: "main", additions: 3, deletions: 1 }],
						},
					},
				},
			},
		}));
		const pulls = await forge.pulls();
		expect(pulls[0]).toMatchObject({ number: 9, state: "open", author: "bo", head: "f", base: "main", additions: 3 });
		expect(sent[0].url).toBe("https://wp.example.com/api/features/forge/github/pulls?project_id=p1");
	});
});

describe("GitLab", () => {
	it("names the project URL-encoded and maps merge requests", async () => {
		const { forge, sent } = await forgeWith("gitlab", "https://gitlab.example.com/group/sub/app.git", () => ({
			status: 200,
			body: [{ iid: 5, title: "MR", state: "opened", author: { username: "cy" }, source_branch: "x", target_branch: "main", merge_status: "can_be_merged" }],
		}));
		const pulls = await forge.pulls();
		expect(pulls[0]).toMatchObject({ number: 5, author: "cy", head: "x", base: "main", mergeable: true });
		expect(sent[0].body.endpoint).toBe("/projects/group%2Fsub%2Fapp/merge_requests?state=opened&per_page=50");
		expect(forge.canCommentIssues).toBe(false);
	});

	it("leaves system notes out of an issue's thread", async () => {
		const { forge } = await forgeWith("gitlab", "https://gitlab.com/g/app", () => ({
			status: 200,
			body: [
				{ id: 1, body: "changed the label", system: true },
				{ id: 2, body: "Looks good", author: { username: "cy" } },
			],
		}));
		expect((await forge.issueComments(5)).map((c) => c.body)).toEqual(["Looks good"]);
	});
});

describe("reviews", () => {
	it("reads a saved review defensively", () => {
		const review = readReview(
			JSON.stringify({
				summary: "Two issues",
				verdict: "needs_revision",
				findings: [{ id: "f1", severity: "high", title: "SQL injection", file: "a.py", line: 3 }, { severity: "low" }],
			}),
		);
		expect(review).toMatchObject({ summary: "Two issues", verdict: "needs_revision" });
		expect(review?.findings.map((f) => f.id)).toEqual(["f1"]);
		expect(readReview("{")).toBeNull();
		expect(readReview(null)).toBeNull();
	});

	it("asks the server for the saved reviews of a request", async () => {
		const { forge, sent } = await forgeWith("github", "https://github.com/acme/app", () => ({
			reviews: { "7": JSON.stringify({ summary: "ok", findings: [] }), "8": null },
		}));
		const reviews = await forge.reviews([7, 8]);
		expect(reviews["7"]?.summary).toBe("ok");
		expect(reviews["8"]).toBeNull();
		expect(sent[0].url).toBe("https://wp.example.com/api/features/forge/github/reviews?project_id=p1&numbers=7,8");
	});
});
