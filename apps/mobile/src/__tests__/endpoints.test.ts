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
	it("registers and forgets this phone for push", async () => {
		const { calls, routes } = recorder();
		await routes.registerDevice("tok", "android", "fr");
		await routes.unregisterDevice("tok");
		expect(calls).toEqual([
			{ method: "PUT", path: "/users/me/devices", body: { token: "tok", platform: "android", locale: "fr" } },
			{ method: "DELETE", path: "/users/me/devices", body: { token: "tok" } },
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
