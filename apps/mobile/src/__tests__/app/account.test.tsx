import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { getSharedPayloads } from "expo-sharing";
import { Alert } from "react-native";
import { loadSession } from "../../auth/token-store";
import { formatDate } from "../../ui/format";
import { type Call, fakeServer, openApp, reply, restoreFetch, SERVER } from "../../../test-support/fake-server";

jest.mock("expo-sharing", () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn() }));

const SHOP = {
	id: "p1",
	name: "Shop",
	repo_url: "https://github.com/acme/shop.git",
	default_branch: "main",
	my_role: "owner",
};

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("projects", () => {
	it("lists the organization's projects with their repository, branch and the person's role", async () => {
		fakeServer({ "GET /projects": [SHOP, { ...SHOP, id: "p2", name: "Blog", my_role: null }] });
		const app = await openApp("/");
		expect(await screen.findByText("Shop")).toBeTruthy();
		expect(screen.getByText("Blog")).toBeTruthy();
		expect(screen.getAllByText(/acme\/shop · main/)).toHaveLength(2);
		expect(screen.getByText("Role: Owner")).toBeTruthy();
		expect(app.getPathname()).toBe("/");
	});

	it("says there is no project yet", async () => {
		fakeServer({ "GET /projects": [] });
		await openApp("/");
		expect(await screen.findByText("No project yet. Add one from the desktop app.")).toBeTruthy();
	});

	it("opens a project's board", async () => {
		fakeServer({ "GET /projects": [SHOP], "GET /api/board/cards": { cards: [] } });
		const app = await openApp("/");
		await fireEvent.press(await screen.findByRole("button", { name: "Shop" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1"));
	});

	it("shows the server's error instead of the list", async () => {
		fakeServer({ "GET /projects": reply(500, { detail: "database down" }) });
		await openApp("/");
		expect(await screen.findByText(/database down/)).toBeTruthy();
		expect(screen.queryByText("No project yet. Add one from the desktop app.")).toBeNull();
	});
});

describe("settings", () => {
	it("shows the account and server, switches organization and signs out", async () => {
		const server = fakeServer(
			{
				"POST /auth/switch-org": { access_token: "access-2", refresh_token: "refresh-2", expires_in: 900, user: {} },
				"POST /auth/logout": {},
			},
			["board.read"],
			{
				organizations: [
					{ id: "org-a", name: "Acme", my_role: "owner" },
					{ id: "org-b", name: "Globex" },
				],
			},
		);
		const app = await openApp("/settings");
		expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
		expect(screen.getByText("ada@x.io")).toBeTruthy();
		expect(screen.getByText("https://wp.example.com")).toBeTruthy();
		// Members cannot administer: no administration entry.
		expect(screen.queryByText("Open the administration")).toBeNull();

		// The organization already in use changes nothing.
		await fireEvent.press(screen.getByRole("radio", { name: /Acme/ }));
		expect(server.called("POST /auth/switch-org")).toHaveLength(0);
		await fireEvent.press(screen.getByRole("radio", { name: /Globex/ }));
		await waitFor(() => expect(server.called("POST /auth/switch-org")).toHaveLength(1));
		expect(server.called("POST /auth/switch-org")[0].body).toEqual({ org_id: "org-b" });

		await fireEvent.press(screen.getByRole("button", { name: "Manage my tokens" }));
		await waitFor(() => expect(app.getPathname()).toBe("/tokens"));
	});

	it("says the session was opened with a password, and since when", async () => {
		const server = fakeServer({});
		await openApp("/settings");
		expect(await screen.findByText("Password")).toBeTruthy();
		expect(screen.getByText("My session")).toBeTruthy();
		expect(screen.getByText("Opened with")).toBeTruthy();
		expect(screen.getByText(formatDate("2026-11-02T16:30:00Z", "en"))).toBeTruthy();
		// A password names no identity provider.
		expect(screen.queryByText("Identity provider")).toBeNull();
		expect(server.called("GET /auth/me/session")).toHaveLength(1);
	});

	it("names the single sign-on provider and its issuer, and nothing else it was sent", async () => {
		fakeServer({
			"GET /auth/me/session": {
				method: "oidc",
				provider_name: "Okta",
				issuer_host: "acme.okta.com",
				signed_in_at: "not a date",
				login_id: "login-secret-id",
			},
		});
		await openApp("/settings");
		expect(await screen.findByText("Single sign-on: Okta")).toBeTruthy();
		expect(screen.getByText("acme.okta.com")).toBeTruthy();
		expect(screen.queryByText("Signed in at")).toBeNull();
		expect(screen.queryByText(/login-secret-id/)).toBeNull();
	});

	it("says SSO for a provider with no name, and when the method was not recorded", async () => {
		fakeServer({ "GET /auth/me/session": { method: "oidc" } });
		await openApp("/settings");
		expect(await screen.findByText("Single sign-on: SSO")).toBeTruthy();
		restoreFetch();
		fakeServer({ "GET /auth/me/session": { method: null } });
		await openApp("/settings");
		expect(await screen.findByText(/^Not recorded/)).toBeTruthy();
	});

	it("says why the session cannot be read, and still offers to sign out", async () => {
		fakeServer({ "GET /auth/me/session": reply(500, { detail: "audit down" }) });
		await openApp("/settings");
		expect(await screen.findByText(/audit down/)).toBeTruthy();
		expect(screen.getByText("Ada Lovelace")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
		restoreFetch();
		fakeServer({ "GET /auth/me/session": "not a session" });
		await openApp("/settings");
		expect(await screen.findByText("The session cannot be read from the server")).toBeTruthy();
	});

	it("says why an organization switch failed", async () => {
		fakeServer(
			{ "POST /auth/switch-org": reply(409, { detail: "not a member any more" }) },
			["board.read"],
			{ organizations: [{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Globex" }] },
		);
		await openApp("/settings");
		await fireEvent.press(await screen.findByRole("radio", { name: /Globex/ }));
		expect(await screen.findByText(/not a member any more/)).toBeTruthy();
	});

	it("offers the administration to an organization admin", async () => {
		fakeServer({ "GET /admin/members": [] }, ["org.member.read"]);
		const app = await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "Open the administration" }));
		await waitFor(() => expect(app.getPathname()).toBe("/admin"));
	});

	it("signs out to the sign-in screen", async () => {
		const server = fakeServer({ "POST /auth/logout": {}, "GET /auth/config": { local_enabled: true } });
		const app = await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(app.getPathname()).toBe("/sign-in"));
		expect(server.called("POST /auth/logout")[0].body).toEqual({ refresh_token: "refresh-1" });
	});
});

describe("my tokens", () => {
	it("says which tokens are saved, adds one and never shows it back", async () => {
		let kinds = ["github_token"];
		const server = fakeServer({
			"GET /users/me/secrets": () => ({ kinds }),
			"PUT /users/me/secrets": (call: Call) => {
				kinds = [...kinds, (call.body as { kind: string }).kind];
				return { saved: true };
			},
		});
		await openApp("/tokens");
		expect(await screen.findByText("GitHub")).toBeTruthy();
		expect(screen.getAllByText("Saved")).toHaveLength(1);
		expect(screen.getAllByText("Not set")).toHaveLength(5);

		const addButtons = screen.getAllByRole("button", { name: "Add" });
		await fireEvent.press(addButtons[0]); // GitLab, the first kind not set
		const field = screen.getByLabelText("GitLab token");
		await fireEvent.changeText(field, "  glpat-secret  ");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.getAllByText("Saved")).toHaveLength(2));
		expect(server.called("PUT /users/me/secrets")[0].body).toEqual({ kind: "gitlab_token", value: "glpat-secret" });
		expect(screen.queryByDisplayValue("glpat-secret")).toBeNull();
	});

	it("cancels an edit, and removes a token after confirmation", async () => {
		let kinds = ["github_token"];
		const server = fakeServer({
			"GET /users/me/secrets": () => ({ kinds }),
			"DELETE /users/me/secrets/github_token": () => {
				kinds = [];
				return { deleted: true };
			},
		});
		const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
			buttons?.find((b) => b.style === "destructive")?.onPress?.();
		});
		await openApp("/tokens");
		await fireEvent.press(await screen.findByRole("button", { name: "Replace" }));
		expect(screen.getByLabelText("GitHub token")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("GitHub token")).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Remove" }));
		expect(alert.mock.calls[0][0]).toBe("Remove the GitHub token?");
		await waitFor(() => expect(screen.getAllByText("Not set")).toHaveLength(6));
		expect(server.called("DELETE /users/me/secrets/github_token")).toHaveLength(1);
	});

	it("shows the server's refusal next to the token", async () => {
		fakeServer({
			"GET /users/me/secrets": { kinds: [] },
			"PUT /users/me/secrets": reply(422, { detail: "token too short" }),
		});
		await openApp("/tokens");
		await fireEvent.press((await screen.findAllByRole("button", { name: "Add" }))[0]);
		await fireEvent.changeText(screen.getByLabelText("GitHub token"), "x");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/token too short/)).toBeTruthy();
		// Still editing: the person can correct it.
		expect(screen.getByLabelText("GitHub token")).toBeTruthy();
	});
});

describe("share into a card", () => {
	it("has nothing to make a card from without a share, and goes back to the projects", async () => {
		fakeServer({ "GET /projects": [SHOP] });
		const app = await openApp("/share");
		expect(await screen.findByText("Nothing to make a card from: share text or a link.")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Back to projects" }));
		await waitFor(() => expect(app.getPathname()).toBe("/"));
	});

	it("shows the shared text and opens New card in the project picked", async () => {
		(getSharedPayloads as jest.Mock).mockReturnValue([{ contentType: "text", value: "Login fails on Safari" }]);
		fakeServer({ "GET /projects": [SHOP], "GET /api/board/engines": { engines: [] } });
		const app = await openApp("/share");
		expect(await screen.findByText("Create a card in which project?")).toBeTruthy();
		expect(screen.getByText(/Login fails on Safari/)).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Shop" }));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/new"));
	});

	it("shows why the projects cannot be read, without saying there is none", async () => {
		(getSharedPayloads as jest.Mock).mockReturnValue([{ contentType: "text", value: "Login fails on Safari" }]);
		fakeServer({ "GET /projects": reply(500, { detail: "projects down" }) });
		await openApp("/share");
		expect(await screen.findByText(/projects down/)).toBeTruthy();
		expect(screen.queryByText(/No project yet/)).toBeNull();
	});
});

describe("without an organization", () => {
	it("titles the projects plainly and lists no organization when the server names none", async () => {
		fakeServer({ "GET /projects": [SHOP] }, ["board.read"], { organizations: [] });
		await openApp("/");
		expect(await screen.findByText("Shop")).toBeTruthy();
		restoreFetch();

		fakeServer({}, ["board.read"], { organizations: [] });
		await openApp("/settings");
		expect(await screen.findByText("ada@x.io")).toBeTruthy();
		expect(screen.queryByText("Organization")).toBeNull();
	});
});

describe("unreachable server", () => {
	it("keeps the session, tries again, or signs out", async () => {
		let up = false;
		fakeServer({
			"POST /auth/refresh": () => {
				if (!up) throw new TypeError("Network request failed");
				return { access_token: "a", refresh_token: "r", expires_in: 900, user: {} };
			},
			"GET /projects": [SHOP],
		});
		await openApp("/");
		expect(await screen.findByText("Server unreachable")).toBeTruthy();
		up = true;
		await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Shop")).toBeTruthy();
	});

	it("signs out from the unreachable screen, keeping the server's address", async () => {
		fakeServer({
			"POST /auth/refresh": () => {
				throw new TypeError("Network request failed");
			},
		});
		const app = await openApp("/");
		await fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(app.getPathname()).toBe("/sign-in"));
		expect(await loadSession()).toEqual({ serverUrl: SERVER, refreshToken: null, orgId: null });
	});
});
