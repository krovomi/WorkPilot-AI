/**
 * @vitest-environment node
 *
 * The open pull request list, read through GitHub's GraphQL API (a stand-in
 * fetch) or relayed by the server for a server project. The repository
 * reaches GraphQL as variables, never inside the query text; GitHub's own
 * error text stays in the log, and a list that cannot be read is empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relay = vi.hoisted(() => vi.fn());
vi.mock("../server-relay", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server-relay")>()),
	isServerHandle: (token: string) => token.startsWith("server:"),
	relayOpenPulls: relay,
}));

import {
	type GraphQLPRNode,
	LIST_PRS_QUERY,
	fetchPRsFromGraphQL,
	githubGraphQL,
	mapGraphQLPRToData,
} from "../pr-graphql";

const fetchMock = vi.fn();
const node = (n: number, extra: Partial<GraphQLPRNode> = {}): GraphQLPRNode => ({
	number: n,
	title: `PR ${n}`,
	body: "body",
	state: "OPEN",
	author: { login: "ana" },
	headRefName: `feat/${n}`,
	baseRefName: "develop",
	additions: 3,
	deletions: 1,
	changedFiles: 2,
	assignees: { nodes: [{ login: "bo" }] },
	createdAt: "2026-11-01T00:00:00Z",
	updatedAt: "2026-11-02T00:00:00Z",
	url: `https://github.com/acme/shop/pull/${n}`,
	...extra,
});
const page = (nodes: GraphQLPRNode[], hasNextPage = false, endCursor: string | null = null) => ({
	data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } },
});
const answer = (body: unknown, status = 200) =>
	fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, statusText: status === 200 ? "" : "Bad" }));

beforeEach(() => {
	fetchMock.mockReset();
	relay.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mapGraphQLPRToData", () => {
	it("maps a node for the app, with a lower-case state and no files yet", () => {
		expect(mapGraphQLPRToData(node(4))).toEqual({
			number: 4,
			title: "PR 4",
			body: "body",
			state: "open",
			author: { login: "ana" },
			headRefName: "feat/4",
			baseRefName: "develop",
			additions: 3,
			deletions: 1,
			changedFiles: 2,
			assignees: [{ login: "bo" }],
			files: [],
			createdAt: "2026-11-01T00:00:00Z",
			updatedAt: "2026-11-02T00:00:00Z",
			htmlUrl: "https://github.com/acme/shop/pull/4",
		});
	});

	it("fills an empty body and a deleted author", () => {
		expect(mapGraphQLPRToData(node(4, { body: null, author: null }))).toMatchObject({
			body: "",
			author: { login: "unknown" },
		});
	});
});

describe("githubGraphQL", () => {
	it("posts the query and its variables with the token", async () => {
		answer({ data: { ok: true } });

		await expect(githubGraphQL("pat-test-0000", "query { viewer { login } }")).resolves.toEqual({
			data: { ok: true },
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.github.com/graphql");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer pat-test-0000");
		expect(JSON.parse(init.body)).toEqual({ query: "query { viewer { login } }", variables: {} });
	});

	it("keeps GitHub's error text in the log and throws a plain message", async () => {
		answer({}, 502);
		await expect(githubGraphQL("t", "q")).rejects.toThrow("Failed to connect to GitHub API");

		answer({ data: null, errors: [{ message: "Could not resolve to a Repository" }] });
		await expect(githubGraphQL("t", "q")).rejects.toThrow("GitHub API request failed");
		expect(console.error).toHaveBeenLastCalledWith("GitHub GraphQL errors: Could not resolve to a Repository");

		answer({ data: { ok: true }, errors: [] });
		await expect(githubGraphQL("t", "q")).resolves.toMatchObject({ data: { ok: true } });
	});
});

describe("fetchPRsFromGraphQL", () => {
	it("lists the open pull requests of the repository, owner and name as variables", async () => {
		answer(page([node(1), node(2)], true, "c1"));

		const result = await fetchPRsFromGraphQL(
			{ token: "pat-test-0000", repo: "https://github.com/acme/shop.git" },
			null,
			"list",
		);

		expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
		expect(result).toMatchObject({ hasNextPage: true, endCursor: "c1" });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: LIST_PRS_QUERY,
			variables: { owner: "acme", repo: "shop", first: 100, after: null },
		});
	});

	it("passes the cursor of the next page", async () => {
		answer(page([node(3)]));

		await fetchPRsFromGraphQL({ token: "t", repo: "acme/shop" }, "c1", "more");

		expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.after).toBe("c1");
	});

	it("asks the server for a server project", async () => {
		relay.mockResolvedValue(page([node(9)]));

		const result = await fetchPRsFromGraphQL({ token: "server:p", repo: "acme/shop" }, "c2", "list");

		expect(result.prs.map((p) => p.number)).toEqual([9]);
		expect(relay).toHaveBeenCalledWith("server:p", 100, "c2");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([["acme"], ["acme/shop/extra"], ["/shop"], [""]])(
		"answers an empty list for the reference %j, without calling GitHub",
		async (repo) => {
			expect(await fetchPRsFromGraphQL({ token: "t", repo }, null, "list")).toEqual({
				prs: [],
				hasNextPage: false,
				endCursor: null,
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a repository GitHub does not show", () => answer({ data: { repository: null } })],
		["a GraphQL error", () => answer({ errors: [{ message: "nope" }] })],
		["a network failure", () => fetchMock.mockRejectedValue(new Error("ECONNRESET"))],
		["an odd failure", () => fetchMock.mockRejectedValue("odd")],
	])("answers an empty list for %s", async (_, arrange) => {
		arrange();

		expect(await fetchPRsFromGraphQL({ token: "t", repo: "acme/shop" }, null, "list")).toEqual({
			prs: [],
			hasNextPage: false,
			endCursor: null,
		});
	});
});
