import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { Alert } from "react-native";
import type { AiAccount, AiAccounts } from "../../ai-accounts/types";
import { providersWithAccounts } from "../../ai-accounts/types";
import { formatDate } from "../../ui/format";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

jest.mock("expo-sharing", () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn() }));

const PROVIDERS = ["claude", "openai", "mistral"];
const WRITE = ["settings.account.read", "settings.account.write"];

function account(id: string, provider: string, name: string, isDefault: boolean): AiAccount {
	return {
		id,
		provider,
		name,
		is_default: isDefault,
		has_key: true,
		created_at: "2026-11-20T10:00:00Z",
		key_set_at: "2026-11-21T10:00:00Z",
	};
}

/** A server that keeps the accounts it is given and answers the five routes. */
function accountsServer(start: AiAccount[], permissions = WRITE) {
	let accounts = [...start];
	const snapshot = (): AiAccounts => ({
		accounts,
		defaults: Object.fromEntries(accounts.filter((a) => a.is_default).map((a) => [a.provider, a.id])),
		providers: PROVIDERS,
	});
	const routes: Record<string, (call: Call) => unknown> = {
		"GET /users/me/ai-accounts": () => snapshot(),
		"POST /users/me/ai-accounts": (call) => {
			const body = call.body as { provider: string; name: string; key: string };
			const made = account(`a${accounts.length + 1}`, body.provider, body.name, !accounts.some((a) => a.provider === body.provider));
			accounts = [...accounts, made];
			return made;
		},
	};
	for (const a of start) {
		routes[`PATCH /users/me/ai-accounts/${a.id}`] = (call) => {
			const change = call.body as { name?: string };
			accounts = accounts.map((x) => (x.id === a.id ? { ...x, name: change.name ?? x.name } : x));
			return accounts.find((x) => x.id === a.id);
		};
		routes[`DELETE /users/me/ai-accounts/${a.id}`] = () => {
			const gone = accounts.find((x) => x.id === a.id);
			accounts = accounts.filter((x) => x.id !== a.id);
			return { deleted: true, was_default: !!gone?.is_default };
		};
	}
	for (const provider of PROVIDERS) {
		routes[`PUT /users/me/ai-accounts/defaults/${provider}`] = (call) => {
			const chosen = (call.body as { account_id: string | null }).account_id;
			accounts = accounts.map((x) => (x.provider === provider ? { ...x, is_default: x.id === chosen } : x));
			return { provider, account_id: chosen };
		};
	}
	return fakeServer(routes, permissions);
}

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("providersWithAccounts", () => {
	it("keeps the server's order, then a provider the server no longer lists", () => {
		const data: AiAccounts = {
			accounts: [account("1", "legacy", "Old", true), account("2", "mistral", "M", true), account("3", "openai", "O", true)],
			defaults: {},
			providers: PROVIDERS,
		};
		expect(providersWithAccounts(data)).toEqual(["openai", "mistral", "legacy"]);
	});
});

describe("my AI accounts", () => {
	it("opens from Settings when the role may read them, and not otherwise", async () => {
		accountsServer([]);
		const app = await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "My AI accounts" }));
		await waitFor(() => expect(app.getPathname()).toBe("/ai-accounts"));
		expect(await screen.findByText("No account yet: your runs use the server's accounts.")).toBeTruthy();
		restoreFetch();
		fakeServer({});
		await openApp("/settings");
		expect(await screen.findByRole("button", { name: "My tokens on the server" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "My AI accounts" })).toBeNull();
	});

	it("shows each provider's accounts with the default chosen, and switches it", async () => {
		const server = accountsServer([
			account("o1", "openai", "Personal", true),
			account("o2", "openai", "Client X", false),
			account("x1", "legacy", "Old", true),
		]);
		await openApp("/ai-accounts");
		expect(await screen.findByRole("header", { name: "OpenAI" })).toBeTruthy();
		// A provider the app has no name for shows its id.
		expect(screen.getByText("legacy")).toBeTruthy();
		expect(screen.getAllByText(`Key saved ${formatDate("2026-11-21T10:00:00Z", "en")}`)).toHaveLength(3);
		expect(screen.getByRole("radio", { name: "Personal" }).props.accessibilityState.selected).toBe(true);

		// The account already chosen changes nothing.
		await fireEvent.press(screen.getByRole("radio", { name: "Personal" }));
		expect(server.called("PUT /users/me/ai-accounts/defaults/openai")).toHaveLength(0);

		await fireEvent.press(screen.getByRole("radio", { name: "Client X" }));
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Client X" }).props.accessibilityState.selected).toBe(true),
		);
		expect(server.called("PUT /users/me/ai-accounts/defaults/openai")[0].body).toEqual({ account_id: "o2" });

		// Back to the server's own account: no default at all.
		await fireEvent.press(screen.getAllByRole("radio", { name: "The server's account" })[0]);
		await waitFor(() => expect(server.called("PUT /users/me/ai-accounts/defaults/openai")).toHaveLength(2));
		expect(server.called("PUT /users/me/ai-accounts/defaults/openai")[1].body).toEqual({ account_id: null });
	});

	it("adds an account and never shows its key back", async () => {
		const server = accountsServer([]);
		await openApp("/ai-accounts");
		await fireEvent.press(await screen.findByRole("radio", { name: "Mistral" }));
		const add = screen.getByRole("button", { name: "Add the account" });
		expect(add.props.accessibilityState.disabled).toBe(true);
		await fireEvent.changeText(screen.getByLabelText("Name"), "  Personal  ");
		await fireEvent.changeText(screen.getByLabelText("API key"), "  sk-test-mobile-0000  ");
		await fireEvent.press(screen.getByRole("button", { name: "Add the account" }));
		await waitFor(() => expect(server.called("POST /users/me/ai-accounts")).toHaveLength(1));
		expect(server.called("POST /users/me/ai-accounts")[0].body).toEqual({
			provider: "mistral",
			name: "Personal",
			key: "sk-test-mobile-0000",
		});
		expect(await screen.findByRole("radio", { name: "Personal" })).toBeTruthy();
		expect(screen.queryByDisplayValue("sk-test-mobile-0000")).toBeNull();
		// The form closed with the provider unpicked.
		expect(screen.queryByLabelText("API key")).toBeNull();
	});

	it("asks Claude for its Claude Code token, and shows the server's refusal", async () => {
		fakeServer(
			{
				"GET /users/me/ai-accounts": { accounts: [], defaults: {}, providers: PROVIDERS },
				"POST /users/me/ai-accounts": reply(400, { detail: "Invalid key" }),
			},
			WRITE,
		);
		await openApp("/ai-accounts");
		await fireEvent.press(await screen.findByRole("radio", { name: "Claude" }));
		await fireEvent.changeText(screen.getByLabelText("Name"), "Team");
		await fireEvent.changeText(screen.getByLabelText("Claude Code token (claude setup-token)"), "bad key");
		await fireEvent.press(screen.getByRole("button", { name: "Add the account" }));
		expect(await screen.findByText(/Invalid key/)).toBeTruthy();
		// Still filled in: the person can correct it.
		expect(screen.getByLabelText("Claude Code token (claude setup-token)")).toBeTruthy();
	});

	it("renames an account, replaces its key, and closes an edit that changes nothing", async () => {
		const server = accountsServer([account("o1", "openai", "Personal", true)]);
		await openApp("/ai-accounts");
		await fireEvent.press(await screen.findByRole("button", { name: "Edit Personal" }));
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(screen.queryByLabelText("New key (leave empty to keep the current one)")).toBeNull();
		expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

		await fireEvent.press(screen.getByRole("button", { name: "Edit Personal" }));
		await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Name")).toBeNull();

		await fireEvent.press(screen.getByRole("button", { name: "Edit Personal" }));
		await fireEvent.changeText(screen.getAllByLabelText("Name")[0], " Home ");
		await fireEvent.changeText(screen.getByLabelText("New key (leave empty to keep the current one)"), " sk-test-new-0000 ");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(server.called("PATCH /users/me/ai-accounts/o1")).toHaveLength(1));
		expect(server.called("PATCH /users/me/ai-accounts/o1")[0].body).toEqual({ name: "Home", key: "sk-test-new-0000" });
		expect(await screen.findByRole("radio", { name: "Home" })).toBeTruthy();

		// The key alone, the name left as it is.
		await fireEvent.press(screen.getByRole("button", { name: "Edit Home" }));
		await fireEvent.changeText(screen.getByLabelText("New key (leave empty to keep the current one)"), "sk-test-other-0000");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(server.called("PATCH /users/me/ai-accounts/o1")).toHaveLength(2));
		expect(server.called("PATCH /users/me/ai-accounts/o1")[1].body).toEqual({ key: "sk-test-other-0000" });
	});

	it("keeps the edit open when the server refuses it", async () => {
		fakeServer(
			{
				"GET /users/me/ai-accounts": {
					accounts: [account("o1", "openai", "Personal", true)],
					defaults: { openai: "o1" },
					providers: PROVIDERS,
				},
				"PATCH /users/me/ai-accounts/o1": reply(400, { detail: "A name of 1 to 80 characters" }),
			},
			WRITE,
		);
		await openApp("/ai-accounts");
		await fireEvent.press(await screen.findByRole("button", { name: "Edit Personal" }));
		await fireEvent.changeText(screen.getAllByLabelText("Name")[0], "Other");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/A name of 1 to 80 characters/)).toBeTruthy();
		expect(screen.getByLabelText("New key (leave empty to keep the current one)")).toBeTruthy();
	});

	it("removes an account after confirmation", async () => {
		const server = accountsServer([account("o1", "openai", "Personal", true)]);
		const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
			buttons?.find((b) => b.style === "destructive")?.onPress?.();
		});
		await openApp("/ai-accounts");
		await fireEvent.press(await screen.findByRole("button", { name: "Remove Personal" }));
		expect(alert.mock.calls[0][0]).toBe("Remove the account Personal?");
		await waitFor(() => expect(server.called("DELETE /users/me/ai-accounts/o1")).toHaveLength(1));
		expect(await screen.findByText("No account yet: your runs use the server's accounts.")).toBeTruthy();
	});

	it("is read-only for a role that may not change accounts", async () => {
		const server = accountsServer([account("o1", "openai", "Personal", true)], ["settings.account.read"]);
		await openApp("/ai-accounts");
		expect(await screen.findByText("Your role does not let you add or change AI accounts.")).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Personal" }).props.accessibilityState.disabled).toBe(true);
		expect(screen.queryByRole("button", { name: "Edit Personal" })).toBeNull();
		expect(screen.queryByText("Add an account")).toBeNull();
		expect(server.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/auth") && !c.path.includes("devices"))).toHaveLength(0);
	});

	it("shows the server's error instead of the list", async () => {
		fakeServer({ "GET /users/me/ai-accounts": reply(500, { detail: "vault down" }) }, WRITE);
		await openApp("/ai-accounts");
		expect(await screen.findByText(/vault down/)).toBeTruthy();
		expect(screen.queryByText("Add an account")).toBeNull();
	});
});
