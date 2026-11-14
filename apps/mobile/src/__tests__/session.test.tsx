import { useAdminApi } from "../admin/api";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { Text } from "react-native";
import { type Session, SessionProvider, useApi, useSession } from "../auth/session";

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const user = { id: "u1", email: "ada@x.io", display_name: "Ada", role: "member" };
const tokens = (n: number) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900, user });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

function serve(handler: Handler) {
	globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
		return handler(String(url), init ?? {});
	}) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let session: Session | null = null;
function Probe() {
	session = useSession();
	return <Text testID="status">{session.status}</Text>;
}

async function mount() {
	await render(
		<SessionProvider>
			<Probe />
		</SessionProvider>,
	);
}

beforeEach(() => {
	store.clear();
	calls = [];
	session = null;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Store a signed-in session the way a previous launch left it. */
async function previousLaunch(orgId: string | null = "org-a") {
	const { saveSession } = jest.requireActual("../auth/token-store") as typeof import("../auth/token-store");
	await saveSession({ serverUrl: "https://wp.example.com", refreshToken: "refresh-0", orgId });
}

describe("SessionProvider", () => {
	it("is signed out at launch without a stored session", async () => {
		serve(() => json({}));
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedOut"));
		expect(calls).toHaveLength(0);
		expect(session?.api).toBeNull();
		expect(session?.can("board.read")).toBe(false);
	});

	it("resumes a stored session, then reads what the person may do", async () => {
		await previousLaunch();
		serve((url) => {
			if (url.endsWith("/auth/refresh")) return json(tokens(1));
			return json({ org_id: "org-a", permissions: ["board.read"], is_platform_admin: false });
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedIn"));
		expect(calls[0]).toEqual({ url: "https://wp.example.com/auth/refresh", body: { refresh_token: "refresh-0" } });
		expect(session?.user).toEqual(user);
		expect(session?.serverUrl).toBe("https://wp.example.com");
		expect(session?.can("board.read")).toBe(true);
		expect(session?.can("admin.members")).toBe(false);
		// The new refresh token replaced the old one in the Keychain.
		expect([...store.values()]).toContain("refresh-1");
		expect([...store.values()]).not.toContain("refresh-0");
	});

	it("adopts the organization the server resolved when none was stored", async () => {
		await previousLaunch(null);
		serve((url) => {
			if (url.endsWith("/auth/refresh")) return json(tokens(1));
			return json({ org_id: "org-z", permissions: [], is_platform_admin: true });
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedIn"));
		expect(session?.client?.activeOrgId).toBe("org-z");
		expect([...store.values()]).toContain("org-z");
		// A platform admin may do everything.
		expect(session?.can("anything")).toBe(true);
	});

	it("signs out when the server refuses the stored token", async () => {
		await previousLaunch();
		serve(() => json({ detail: "revoked" }, 401));
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedOut"));
		expect([...store.values()]).not.toContain("refresh-0");
	});

	it("keeps the session when the server is unreachable, and tries again on demand", async () => {
		await previousLaunch();
		serve(() => {
			throw new TypeError("Network request failed");
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("unreachable"));
		expect([...store.values()]).toContain("refresh-0");

		serve((url) => {
			if (url.endsWith("/auth/refresh")) return json(tokens(2));
			return json({ org_id: "org-a", permissions: [], is_platform_admin: false });
		});
		await act(async () => {
			await session?.retry();
		});
		expect(screen.getByTestId("status").props.children).toBe("signedIn");
	});

	it("signs out when the permissions answer a 401 after the refresh", async () => {
		await previousLaunch();
		serve((url) => (url.endsWith("/auth/refresh") ? json(tokens(1)) : json({ detail: "no" }, 401)));
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedOut"));
	});

	it("is unreachable when the permissions cannot be read for another reason", async () => {
		await previousLaunch();
		serve((url) => (url.endsWith("/auth/refresh") ? json(tokens(1)) : json({ detail: "boom" }, 500)));
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("unreachable"));
	});

	it("switches organization and reads the permissions there", async () => {
		await previousLaunch();
		serve((url) => {
			if (url.endsWith("/auth/refresh")) return json(tokens(1));
			if (url.endsWith("/auth/switch-org")) return json(tokens(2));
			const org = session?.client?.activeOrgId;
			return json({ org_id: org, permissions: org === "org-b" ? ["admin.members"] : [], is_platform_admin: false });
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedIn"));
		await act(async () => {
			await session?.switchOrg("org-b");
		});
		expect(calls.find((c) => c.url.endsWith("/auth/switch-org"))?.body).toEqual({ org_id: "org-b" });
		expect([...store.values()]).toContain("org-b");
		expect(session?.can("admin.members")).toBe(true);
	});

	it("signs out: revokes the token on the server and forgets it on the phone, keeping the address", async () => {
		await previousLaunch();
		serve((url) => {
			if (url.endsWith("/auth/refresh")) return json(tokens(1));
			if (url.endsWith("/auth/logout")) return json({});
			return json({ org_id: "org-a", permissions: [], is_platform_admin: false });
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedIn"));
		await act(async () => {
			await session?.signOut();
		});
		expect(screen.getByTestId("status").props.children).toBe("signedOut");
		expect(calls.find((c) => c.url.endsWith("/auth/logout"))?.body).toEqual({ refresh_token: "refresh-1" });
		expect(session?.user).toBeNull();
		expect(session?.permissions).toBeNull();
		expect([...store.values()]).toEqual(["https://wp.example.com"]);
	});

	it("signs out without a client, and ignores an organization switch then", async () => {
		serve(() => json({}));
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedOut"));
		await act(async () => {
			await session?.switchOrg("org-b");
			await session?.signOut();
		});
		expect(calls).toHaveLength(0);
		expect(screen.getByTestId("status").props.children).toBe("signedOut");
	});

	it("signs out when a later request finds the refresh token refused", async () => {
		await previousLaunch();
		let refused = false;
		serve((url) => {
			if (url.endsWith("/auth/refresh")) return refused ? json({}, 401) : json(tokens(1));
			if (url.endsWith("/permissions")) return json({ org_id: "org-a", permissions: [], is_platform_admin: false });
			return json({ detail: "expired" }, 401);
		});
		await mount();
		await waitFor(() => expect(screen.getByTestId("status").props.children).toBe("signedIn"));
		refused = true;
		await act(async () => {
			await session?.api?.projects().catch(() => undefined);
		});
		expect(screen.getByTestId("status").props.children).toBe("signedOut");
		expect(session?.user).toBeNull();
	});
});

describe("useSession and useApi", () => {
	it("refuse to run outside the provider or without a session", async () => {
		jest.spyOn(console, "error").mockImplementation(() => {});
		await expect(renderHook(() => useSession())).rejects.toThrow("useSession outside SessionProvider");
		serve(() => json({}));
		await expect(
			renderHook(() => useApi(), { wrapper: ({ children }) => <SessionProvider>{children}</SessionProvider> }),
		).rejects.toThrow("useApi without a session");
		await expect(
			renderHook(() => useAdminApi(), { wrapper: ({ children }) => <SessionProvider>{children}</SessionProvider> }),
		).rejects.toThrow("useAdminApi without a session");
		(console.error as jest.Mock).mockRestore();
	});
});
