/**
 * The whole app under test: the real router, session, client and screens,
 * against a fake WorkPilot server that answers from a table of routes and
 * records every call. A test signs in as a previous launch left it (refresh
 * token in the Keychain) and opens a URL of the app.
 */

import { renderRouter } from "expo-router/testing-library";
import { saveSession } from "../src/auth/token-store";

export type Reply = unknown | { status: number; body: unknown };
export type Route = (call: Call) => Reply | Promise<Reply>;
export interface Call {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
}

export const SERVER = "https://wp.example.com";
export const USER = { id: "u1", email: "ada@x.io", display_name: "Ada Lovelace", role: "member" };

export function reply(status: number, body: unknown = {}): Reply {
	return { status, body };
}

function isReply(value: unknown): value is { status: number; body: unknown } {
	return !!value && typeof value === "object" && "status" in value && "body" in value && Object.keys(value).length === 2;
}

export interface FakeServer {
	calls: Call[];
	routes: Record<string, Route | Reply>;
	/** The calls to `METHOD /path`, in order. */
	called(key: string): Call[];
}

const realFetch = globalThis.fetch;

/** Answers `METHOD /path` (no query) from `routes`; anything else is a 404 the test sees in `calls`. */
export function fakeServer(
	routes: Record<string, Route | Reply>,
	permissions: string[] = ["board.read"],
	extra: Partial<{ is_platform_admin: boolean; organizations: { id: string; name: string; my_role?: string }[] }> = {},
): FakeServer {
	const server: FakeServer = {
		calls: [],
		routes: {
			"POST /auth/refresh": { access_token: "access-1", refresh_token: "refresh-1", expires_in: 900, user: USER },
			"GET /auth/me/permissions": {
				org_id: "org-a",
				organizations: extra.organizations ?? [{ id: "org-a", name: "Acme", my_role: "owner" }],
				permissions,
				is_platform_admin: extra.is_platform_admin ?? false,
			},
			"GET /users/me/preferences": { theme: "system", colorTheme: "default" },
			"PUT /users/me/devices": { registered: true },
			"GET /api/board/stream": { url: null },
			...routes,
		},
		called: (key) => server.calls.filter((c) => `${c.method} ${c.path}` === key),
	};
	globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const call: Call = {
			method,
			path: url.pathname,
			query: url.searchParams,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		};
		server.calls.push(call);
		const route = server.routes[`${method} ${url.pathname}`];
		if (route === undefined) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
		const answer = typeof route === "function" ? await (route as Route)(call) : route;
		const { status, body } = isReply(answer) ? answer : { status: 200, body: answer };
		return new Response(body === undefined ? "" : JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return server;
}

export function restoreFetch() {
	globalThis.fetch = realFetch;
}

/** Open the app at `url`, signed in as a previous launch left the person. */
export async function openApp(url: string) {
	await saveSession({ serverUrl: SERVER, refreshToken: "refresh-0", orgId: "org-a" });
	return renderRouter("./src/app", { initialUrl: url });
}
