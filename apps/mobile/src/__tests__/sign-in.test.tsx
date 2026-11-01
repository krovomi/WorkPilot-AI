import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import SignIn from "../app/sign-in";
import { SessionProvider, useSession } from "../auth/session";
import "../i18n";
import { Text } from "react-native";

const user = { id: "u1", email: "ada@x.io", display_name: "Ada", role: "member" };

function Status() {
	const { status, permissions } = useSession();
	return <Text testID="status">{`${status}:${permissions?.org_id ?? ""}`}</Text>;
}

function respond(body: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

async function app() {
	return await render(
		<SessionProvider>
			<Status />
			<SignIn />
		</SessionProvider>,
	);
}

describe("sign-in screen", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("refuses plain http to a public server before sending the password", async () => {
		const fetchMock = jest.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await app();
		await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut:"));
		await fireEvent.changeText(screen.getByLabelText("Server address"), "http://workpilot.example.com");
		await fireEvent.changeText(screen.getByLabelText("Email"), "ada@x.io");
		await fireEvent.changeText(screen.getByLabelText("Password"), "secret");
		await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByText(/Use an https:\/\/ address/)).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("signs in and adopts the organization the server resolved", async () => {
		const fetchMock = jest.fn((url: string) => {
			if (url.endsWith("/auth/config")) return respond({ local_enabled: true, entra_enabled: false });
			if (url.endsWith("/auth/login"))
				return respond({ access_token: "a", refresh_token: "r", expires_in: 900, user });
			if (url.endsWith("/auth/me/permissions"))
				return respond({
					user_id: "u1",
					is_platform_admin: false,
					org_id: "org-a",
					org_role: "member",
					permissions: ["task.read"],
					organizations: [{ id: "org-a", name: "Team A", slug: "a" }],
				});
			return respond({ detail: "unexpected" }, 500);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await app();
		await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut:"));
		await fireEvent.changeText(screen.getByLabelText("Server address"), "wp.example.com");
		await fireEvent.changeText(screen.getByLabelText("Email"), " ada@x.io ");
		await fireEvent.changeText(screen.getByLabelText("Password"), "secret");
		await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn:org-a"));
		const login = fetchMock.mock.calls.find(([url]) => url.endsWith("/auth/login"));
		expect(login?.[0]).toBe("https://wp.example.com/auth/login");
		expect(JSON.parse(String((login as unknown as [string, RequestInit])[1].body))).toEqual({
			email: "ada@x.io",
			password: "secret",
		});
	});

	it("shows the server's refusal", async () => {
		globalThis.fetch = jest.fn((url: string) =>
			url.endsWith("/auth/config")
				? respond({ local_enabled: true, entra_enabled: false })
				: respond({ detail: "Invalid credentials" }, 401),
		) as unknown as typeof fetch;
		await app();
		await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut:"));
		await fireEvent.changeText(screen.getByLabelText("Server address"), "wp.example.com");
		await fireEvent.changeText(screen.getByLabelText("Email"), "ada@x.io");
		await fireEvent.changeText(screen.getByLabelText("Password"), "nope");
		await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByText(/Sign-in failed/)).toBeTruthy();
	});
});
