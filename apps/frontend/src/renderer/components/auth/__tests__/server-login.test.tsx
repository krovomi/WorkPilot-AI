/** @vitest-environment jsdom */
/**
 * The server connection gate: it offers Microsoft sign-in only when the server
 * has it, signs in with a local account, falls back to local mode, and leads to
 * the invitation form, where an invitee sets a password for the email the
 * server bound to the invitation.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { useServerSessionStore } from "@/stores/server-session-store";
import { AcceptInviteForm } from "../AcceptInviteForm";
import { ServerLoginScreen } from "../ServerLoginScreen";

const LAST_URL = "workpilot-last-server-url";
const SERVER = "https://team.example.test";
const TOKEN = "fake-invite-token-0123456789";

const serverAuth = {
	getConfig: vi.fn(),
	loginLocal: vi.fn(),
	loginEntra: vi.fn(),
	lookupInvite: vi.fn(),
	acceptInvite: vi.fn(),
};
const switchToLocalMode = vi.fn();

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	for (const fn of Object.values(serverAuth)) fn.mockReset();
	switchToLocalMode.mockReset().mockResolvedValue(undefined);
	serverAuth.getConfig.mockResolvedValue({ ok: true, data: { entra_enabled: false } });
	(window as unknown as { electronAPI: unknown }).electronAPI = { serverAuth };
	localStorage.clear();
	useServerSessionStore.setState({ serverUrl: null, isLoginScreenOpen: true, switchToLocalMode });
});

afterEach(() => {
	cleanup();
});

function type(label: string, value: string): void {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const signInButton = () => screen.getByRole("button", { name: "Sign in" });
const entraButton = () => screen.queryByRole("button", { name: "Sign in with Microsoft" });

describe("ServerLoginScreen", () => {
	it("starts from the session's server, else the last one used, else nothing", async () => {
		useServerSessionStore.setState({ serverUrl: SERVER });
		localStorage.setItem(LAST_URL, "https://old.example.test");
		render(<ServerLoginScreen />);
		expect(screen.getByLabelText("Server URL")).toHaveValue(SERVER);
		cleanup();

		useServerSessionStore.setState({ serverUrl: null });
		render(<ServerLoginScreen />);
		expect(screen.getByLabelText("Server URL")).toHaveValue("https://old.example.test");
		cleanup();

		localStorage.clear();
		render(<ServerLoginScreen />);
		expect(screen.getByLabelText("Server URL")).toHaveValue("");
		await new Promise((r) => setTimeout(r, 600));
		expect(serverAuth.getConfig).not.toHaveBeenCalled();
	});

	it("offers Microsoft sign-in only when the server says it has it", async () => {
		serverAuth.getConfig.mockResolvedValue({ ok: true, data: { entra_enabled: true } });
		render(<ServerLoginScreen />);
		type("Server URL", `  ${SERVER} `);
		await waitFor(() => expect(entraButton()).toBeInTheDocument());
		expect(serverAuth.getConfig).toHaveBeenCalledWith(SERVER);

		serverAuth.getConfig.mockResolvedValue({ ok: false, error: "no" });
		type("Server URL", "https://other.example.test");
		await waitFor(() => expect(entraButton()).not.toBeInTheDocument());

		serverAuth.getConfig.mockResolvedValue({ ok: true, data: { entra_enabled: true } });
		type("Server URL", SERVER);
		await waitFor(() => expect(entraButton()).toBeInTheDocument());
		serverAuth.getConfig.mockRejectedValue(new Error("unreachable"));
		type("Server URL", "https://down.example.test");
		await waitFor(() => expect(entraButton()).not.toBeInTheDocument());
	});

	it("drops the answer for a server the user has since changed", async () => {
		const slow = deferred<unknown>();
		serverAuth.getConfig.mockImplementation((target: string) =>
			target === SERVER ? slow.promise : Promise.resolve({ ok: true, data: { entra_enabled: false } }),
		);
		render(<ServerLoginScreen />);
		type("Server URL", SERVER);
		await waitFor(() => expect(serverAuth.getConfig).toHaveBeenCalledWith(SERVER));
		type("Server URL", "https://other.example.test");
		await act(async () => slow.resolve({ ok: true, data: { entra_enabled: true } }));
		await waitFor(() => expect(serverAuth.getConfig).toHaveBeenCalledWith("https://other.example.test"));
		await act(() => Promise.resolve());
		expect(entraButton()).not.toBeInTheDocument();
	});

	it("signs in with a local account and remembers the server", async () => {
		const answer = deferred<unknown>();
		serverAuth.loginLocal.mockReturnValue(answer.promise);
		render(<ServerLoginScreen />);
		expect(signInButton()).toBeDisabled();
		type("Server URL", ` ${SERVER} `);
		expect(signInButton()).toBeDisabled();
		type("Email", " dana@example.test ");
		expect(signInButton()).toBeDisabled();
		type("Password", "fake-password");
		fireEvent.click(signInButton());
		expect(serverAuth.loginLocal).toHaveBeenCalledWith(SERVER, "dana@example.test", "fake-password");
		expect(localStorage.getItem(LAST_URL)).toBe(SERVER);
		expect(signInButton()).toBeDisabled();
		expect(screen.getByRole("button", { name: "Local mode" })).toBeDisabled();
		await act(async () => answer.resolve({ ok: true }));
		expect(useServerSessionStore.getState().isLoginScreenOpen).toBe(false);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(signInButton()).toBeEnabled();
	});

	it("submits on Enter only when the button would", async () => {
		serverAuth.loginLocal.mockResolvedValue({ ok: true });
		render(<ServerLoginScreen />);
		type("Server URL", SERVER);
		type("Password", "fake-password");
		fireEvent.keyDown(screen.getByLabelText("Password"), { key: "Enter" });
		expect(serverAuth.loginLocal).not.toHaveBeenCalled();
		type("Email", "dana@example.test");
		fireEvent.keyDown(screen.getByLabelText("Password"), { key: "a" });
		expect(serverAuth.loginLocal).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByLabelText("Password"), { key: "Enter" });
		await waitFor(() => expect(serverAuth.loginLocal).toHaveBeenCalledTimes(1));
	});

	it("says why a sign-in failed, in the app's language when the server gave no reason", async () => {
		render(<ServerLoginScreen />);
		type("Server URL", SERVER);
		type("Email", "dana@example.test");
		type("Password", "fake-password");

		serverAuth.loginLocal.mockResolvedValueOnce({ ok: false, error: "Wrong password" });
		fireEvent.click(signInButton());
		expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");

		serverAuth.loginLocal.mockResolvedValueOnce({ ok: false });
		fireEvent.click(signInButton());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not sign in"));

		serverAuth.loginLocal.mockRejectedValueOnce(new Error("Main process refused"));
		fireEvent.click(signInButton());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Main process refused"));

		serverAuth.loginLocal.mockRejectedValueOnce("gone");
		fireEvent.click(signInButton());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not sign in"));
		expect(signInButton()).toBeEnabled();
	});

	it("signs in with Microsoft through the main process", async () => {
		serverAuth.getConfig.mockResolvedValue({ ok: true, data: { entra_enabled: true } });
		const answer = deferred<unknown>();
		serverAuth.loginEntra.mockReturnValue(answer.promise);
		localStorage.setItem(LAST_URL, ` ${SERVER} `);
		render(<ServerLoginScreen />);
		await waitFor(() => expect(entraButton()).toBeEnabled());
		fireEvent.click(entraButton() as HTMLElement);
		expect(serverAuth.loginEntra).toHaveBeenCalledWith(SERVER);
		expect(localStorage.getItem(LAST_URL)).toBe(SERVER);
		expect(entraButton()).toBeDisabled();
		await act(async () => answer.resolve({ ok: false, error: "Cancelled in the browser" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Cancelled in the browser");
		expect(entraButton()).toBeEnabled();

		type("Server URL", "  ");
		expect(entraButton()).toBeDisabled();
	});

	it("falls back to local mode", () => {
		render(<ServerLoginScreen />);
		fireEvent.click(screen.getByRole("button", { name: "Local mode" }));
		expect(switchToLocalMode).toHaveBeenCalledTimes(1);
	});

	it("opens the invitation form without the last error, and comes back", async () => {
		serverAuth.loginLocal.mockResolvedValue({ ok: false, error: "Wrong password" });
		render(<ServerLoginScreen />);
		type("Server URL", SERVER);
		type("Email", "dana@example.test");
		type("Password", "fake-password");
		fireEvent.click(signInButton());
		await screen.findByRole("alert");

		fireEvent.click(screen.getByRole("button", { name: "I have an invitation" }));
		expect(screen.getByText("Create your account")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("Sign in to a WorkPilot server")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("AcceptInviteForm", () => {
	const onBack = vi.fn();

	beforeEach(() => {
		onBack.mockReset();
		serverAuth.lookupInvite.mockResolvedValue({ ok: true, data: { email: "dana@example.test" } });
	});

	async function openInvitation(): Promise<void> {
		render(<AcceptInviteForm onBack={onBack} />);
		type("Server URL", ` ${SERVER} `);
		type("Invitation link or code", ` ${SERVER}/invite?token=${TOKEN} `);
		expect(await screen.findByLabelText("Email")).toHaveValue("dana@example.test");
	}

	function fill(name: string, password: string, confirm = password): void {
		type("Display name", name);
		type("Password", password);
		type("Confirm password", confirm);
	}

	const submit = () => screen.getByRole("button", { name: "Create my account" });

	it("starts from the session's server, else the last one used, else nothing", () => {
		useServerSessionStore.setState({ serverUrl: SERVER });
		localStorage.setItem(LAST_URL, "https://old.example.test");
		render(<AcceptInviteForm onBack={onBack} />);
		expect(screen.getByLabelText("Server URL")).toHaveValue(SERVER);
		cleanup();
		useServerSessionStore.setState({ serverUrl: null });
		render(<AcceptInviteForm onBack={onBack} />);
		expect(screen.getByLabelText("Server URL")).toHaveValue("https://old.example.test");
		cleanup();
		localStorage.clear();
		render(<AcceptInviteForm onBack={onBack} />);
		expect(screen.getByLabelText("Server URL")).toHaveValue("");
	});

	it("reads the token from a link or takes a bare code, once both fields are set", async () => {
		render(<AcceptInviteForm onBack={onBack} />);
		type("Invitation link or code", TOKEN);
		await new Promise((r) => setTimeout(r, 600));
		expect(serverAuth.lookupInvite).not.toHaveBeenCalled();

		type("Server URL", SERVER);
		type("Invitation link or code", "short");
		await new Promise((r) => setTimeout(r, 600));
		expect(serverAuth.lookupInvite).not.toHaveBeenCalled();

		type("Invitation link or code", `  ${TOKEN}  `);
		await waitFor(() => expect(serverAuth.lookupInvite).toHaveBeenCalledWith(SERVER, TOKEN));
		expect(await screen.findByLabelText("Email")).toHaveValue("dana@example.test");

		// A link without a token is passed as it is, and the server does not know it.
		serverAuth.lookupInvite.mockResolvedValue({ ok: false });
		type("Invitation link or code", `${SERVER}/invite?code=abc`);
		await waitFor(() =>
			expect(serverAuth.lookupInvite).toHaveBeenLastCalledWith(SERVER, `${SERVER}/invite?code=abc`),
		);
		expect(await screen.findByText("Invitation not found or expired")).toBeInTheDocument();
		expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();

		type("Invitation link or code", "");
		expect(screen.queryByText("Invitation not found or expired")).not.toBeInTheDocument();
	});

	it("says why an invitation cannot be read", async () => {
		render(<AcceptInviteForm onBack={onBack} />);
		type("Server URL", SERVER);

		serverAuth.lookupInvite.mockResolvedValue({ ok: false, error: "Invitation already used" });
		type("Invitation link or code", TOKEN);
		expect(await screen.findByText("Invitation already used")).toBeInTheDocument();

		serverAuth.lookupInvite.mockRejectedValue(new Error("Server unreachable"));
		type("Invitation link or code", `${TOKEN}-b`);
		expect(await screen.findByText("Server unreachable")).toBeInTheDocument();

		serverAuth.lookupInvite.mockRejectedValue("gone");
		type("Invitation link or code", `${TOKEN}-c`);
		expect(await screen.findByText("Invitation not found or expired")).toBeInTheDocument();

		// An invitation the server finds without an email cannot be accepted.
		serverAuth.lookupInvite.mockResolvedValue({ ok: true, data: { email: "" } });
		type("Invitation link or code", `${TOKEN}-d`);
		await waitFor(() => expect(serverAuth.lookupInvite).toHaveBeenCalledTimes(4));
		expect(await screen.findByText("Invitation not found or expired")).toBeInTheDocument();
		expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
	});

	it("drops the answer for an invitation the user has since changed", async () => {
		const slow = deferred<unknown>();
		serverAuth.lookupInvite.mockImplementation((_url: string, token: string) =>
			token === TOKEN ? slow.promise : Promise.resolve({ ok: false, error: "Unknown invitation" }),
		);
		render(<AcceptInviteForm onBack={onBack} />);
		type("Server URL", SERVER);
		type("Invitation link or code", TOKEN);
		await waitFor(() => expect(serverAuth.lookupInvite).toHaveBeenCalledTimes(1));
		type("Invitation link or code", `${TOKEN}-other`);
		await act(async () => slow.resolve({ ok: true, data: { email: "dana@example.test" } }));
		expect(await screen.findByText("Unknown invitation")).toBeInTheDocument();
		expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
	});

	it("rates the password as a hint and enables the button only for a valid form", async () => {
		await openInvitation();
		expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
		expect(screen.getByText("Very weak")).toBeInTheDocument();
		const rated = (pw: string) => {
			type("Password", pw);
			return screen.getByText(/^(Very weak|Weak|Fair|Good|Strong)$/).textContent;
		};
		expect(rated("short")).toBe("Very weak");
		expect(rated("abcdefghijkl")).toBe("Weak");
		expect(rated("abcdefghijklmnop")).toBe("Fair");
		expect(rated("Abcdefghijklmnop")).toBe("Good");
		expect(rated("Abcdefghijklmn0!")).toBe("Strong");
		expect(rated("abcdefghij1!")).toBe("Fair");
		expect(rated("abcdefghijk1")).toBe("Weak");

		fill("", "Abcdefghijklmn0!");
		expect(submit()).toBeDisabled();
		fill("Dana", "short");
		expect(submit()).toBeDisabled();
		fill("Dana", "Abcdefghijklmn0!", "Abcdefghijklmn0?");
		expect(screen.getByText("The passwords do not match")).toBeInTheDocument();
		expect(submit()).toBeDisabled();
		fill("Dana", "Abcdefghijklmn0!", "");
		expect(screen.queryByText("The passwords do not match")).not.toBeInTheDocument();
		fill("  Dana  ", "Abcdefghijklmn0!");
		expect(submit()).toBeEnabled();
	});

	it("creates the account, remembers the server and signs the user in", async () => {
		const answer = deferred<unknown>();
		serverAuth.acceptInvite.mockReturnValue(answer.promise);
		await openInvitation();
		fill("  Dana  ", "Abcdefghijklmn0!");
		fireEvent.click(submit());
		expect(serverAuth.acceptInvite).toHaveBeenCalledWith(SERVER, TOKEN, "Dana", "Abcdefghijklmn0!");
		expect(localStorage.getItem(LAST_URL)).toBe(SERVER);
		expect(submit()).toBeDisabled();
		expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
		await act(async () => answer.resolve({ ok: true }));
		expect(useServerSessionStore.getState().isLoginScreenOpen).toBe(false);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("submits on Enter only when the button would", async () => {
		serverAuth.acceptInvite.mockResolvedValue({ ok: true });
		await openInvitation();
		fill("Dana", "Abcdefghijklmn0!", "Abcdefghijklmn0");
		const confirm = screen.getByLabelText("Confirm password");
		fireEvent.keyDown(confirm, { key: "Enter" });
		type("Confirm password", "Abcdefghijklmn0!");
		fireEvent.keyDown(confirm, { key: "Tab" });
		expect(serverAuth.acceptInvite).not.toHaveBeenCalled();
		fireEvent.keyDown(confirm, { key: "Enter" });
		await waitFor(() => expect(serverAuth.acceptInvite).toHaveBeenCalledTimes(1));
	});

	it("says why the account was not created", async () => {
		await openInvitation();
		fill("Dana", "Abcdefghijklmn0!");

		serverAuth.acceptInvite.mockResolvedValueOnce({ ok: false, error: "Password too common" });
		fireEvent.click(submit());
		expect(await screen.findByRole("alert")).toHaveTextContent("Password too common");

		serverAuth.acceptInvite.mockResolvedValueOnce({ ok: false });
		fireEvent.click(submit());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not create the account"));

		serverAuth.acceptInvite.mockRejectedValueOnce(new Error("Main process refused"));
		fireEvent.click(submit());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Main process refused"));

		serverAuth.acceptInvite.mockRejectedValueOnce("gone");
		fireEvent.click(submit());
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not create the account"));
		expect(submit()).toBeEnabled();
	});

	it("goes back to sign-in", () => {
		render(<AcceptInviteForm onBack={onBack} />);
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
