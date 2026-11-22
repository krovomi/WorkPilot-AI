/**
 * "Forgot password?" on the phone: ask the server for a link, or paste one
 * and choose the new password. The real router and session, a fake server.
 */
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { tokenOf } from "../../api/password-reset";
import { saveSession } from "../../auth/token-store";
import { fakeServer, reply, restoreFetch, SERVER } from "../../../test-support/fake-server";

const TOKEN = "A".repeat(43);
const LINK = `${SERVER}/reset-password?token=${TOKEN}`;
const PASSWORD = "a-brand-new-passphrase-42"; // pragma: allowlist secret
const CONFIG = { local_enabled: true, entra_enabled: false };

/** Signed out, the address of the last server kept (or none). */
async function open(url: string, serverUrl: string | null = SERVER) {
	await saveSession({ serverUrl, refreshToken: null, orgId: null });
	return renderRouter("./src/app", { initialUrl: url });
}

afterEach(() => restoreFetch());

describe("tokenOf", () => {
	it("reads a pasted link or a bare code, and nothing else", () => {
		expect(tokenOf(LINK)).toBe(TOKEN);
		expect(tokenOf(`  ${TOKEN}\n`)).toBe(TOKEN);
		expect(tokenOf("short")).toBeNull();
		expect(tokenOf(`${SERVER}/reset-password?token=bad`)).toBeNull();
		expect(tokenOf(`${SERVER}/reset-password`)).toBeNull();
	});
});

describe("forgot password screen", () => {
	it("opens from sign-in with the typed address and asks for a link", async () => {
		const server = fakeServer({
			"GET /auth/config": { ...CONFIG, password_reset_by_email: true },
			"POST /auth/password-reset/request": reply(202, { requested: true }),
		});
		await open("/sign-in");
		await fireEvent.changeText(await screen.findByLabelText("Server address"), "wp.example.com");
		await fireEvent.press(screen.getByRole("button", { name: "Forgot password?" }));
		expect(await screen.findByText("Forgotten password")).toBeTruthy();
		expect(screen.getByLabelText("Server address").props.value).toBe("wp.example.com");
		const send = screen.getByRole("button", { name: "Send the link" });
		expect(send).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Email"), " ada@x.io ");
		await fireEvent.press(send);
		expect(await screen.findByText(/a link is on its way/)).toBeTruthy();
		expect(server.called("POST /auth/password-reset/request")[0].body).toEqual({ email: "ada@x.io" });
		await fireEvent.press(screen.getByRole("button", { name: "Back to sign-in" }));
		expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
	});

	it("sends people to an administrator when the server has no email", async () => {
		const server = fakeServer({ "GET /auth/config": CONFIG });
		await open("/forgot-password");
		await fireEvent.changeText(await screen.findByLabelText("Email"), "ada@x.io");
		await fireEvent.press(screen.getByRole("button", { name: "Send the link" }));
		expect(await screen.findByText(/Ask a server administrator/)).toBeTruthy();
		expect(server.called("POST /auth/password-reset/request")).toHaveLength(0);
	});

	it("checks the address before sending anything, and says why a request failed", async () => {
		const server = fakeServer({ "GET /auth/config": reply(500, { detail: "Boom" }) });
		await open("/forgot-password", null);
		await fireEvent.changeText(await screen.findByLabelText("Email"), "ada@x.io");
		const address = screen.getByLabelText("Server address");
		await fireEvent.changeText(address, "ftp://wp.example.com");
		await fireEvent.press(screen.getByRole("button", { name: "Send the link" }));
		expect(await screen.findByText("This isn't a valid server address.")).toBeTruthy();
		await fireEvent.changeText(address, "http://wp.example.com");
		await fireEvent.press(screen.getByRole("button", { name: "Send the link" }));
		expect(await screen.findByText(/Use an https:\/\/ address/)).toBeTruthy();
		expect(server.calls).toHaveLength(0);
		await fireEvent.changeText(address, "wp.example.com");
		await fireEvent.press(screen.getByRole("button", { name: "Send the link" }));
		expect(await screen.findByText("The password could not be reset: Something went wrong: Boom")).toBeTruthy();
	});

	it("sets the new password with a pasted link, then goes back to sign-in", async () => {
		const answers = [
			reply(404, { detail: "This reset link is invalid or has expired" }),
			reply(400, { detail: "Password must be at least 12 characters" }),
			{ reset: true },
		];
		const server = fakeServer({ "POST /auth/password-reset/confirm": () => answers.shift() });
		await open("/forgot-password");
		await fireEvent.press(await screen.findByRole("button", { name: "I have a link" }));
		expect(screen.getByText(/Paste the link you received/)).toBeTruthy();
		const save = screen.getByRole("button", { name: "Set my password" });
		await fireEvent.changeText(screen.getByLabelText("Reset link or code"), LINK);
		await fireEvent.changeText(screen.getByLabelText("New password"), PASSWORD);
		expect(screen.getByText("At least 12 characters.")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Confirm password"), "something-else-1");
		expect(screen.getByText("The passwords do not match.")).toBeTruthy();
		expect(save).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Confirm password"), PASSWORD);
		await fireEvent.press(save);
		expect(await screen.findByText(/invalid or has expired. Ask for a new one/)).toBeTruthy();
		await fireEvent.press(save);
		expect(await screen.findByText(/could not be reset: Something went wrong: Password must be/)).toBeTruthy();
		await fireEvent.press(save);
		expect(await screen.findByText("Your password was changed. Sign in with the new one.")).toBeTruthy();
		expect(server.called("POST /auth/password-reset/confirm")[0].body).toEqual({
			token: TOKEN,
			new_password: PASSWORD,
		});
		// Opened on its own: nothing to go back to, so sign-in replaces it.
		await fireEvent.press(screen.getByRole("button", { name: "Back to sign-in" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
	});

	it("goes back to asking for a link", async () => {
		fakeServer({});
		await open("/forgot-password");
		await fireEvent.press(await screen.findByRole("button", { name: "I have a link" }));
		await fireEvent.press(screen.getByRole("button", { name: "I need a link" }));
		expect(screen.getByRole("button", { name: "Send the link" })).toBeTruthy();
	});
});
