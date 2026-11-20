/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { ClaudeProfile } from "../../../../shared/types";
import { OAuthStep } from "../OAuthStep";

vi.mock("react-i18next", () => {
	const t = (key: string, options?: { error?: string }) =>
		options?.error ? `${key}:${options.error}` : key;
	return {
		useTranslation: () => ({ t }),
		Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
	};
});

const toast = vi.fn();
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const loadGlobalProfiles = vi.fn();
vi.mock("../../../stores/claude-profile-store", () => ({
	loadClaudeProfiles: () => loadGlobalProfiles(),
}));

const mac = { value: false };
vi.mock("../../../lib/os-detection", () => ({ isMacOS: () => mac.value }));

// The real terminal needs xterm; this one exposes what the step hands it.
vi.mock("../../settings/AuthTerminal", () => ({
	AuthTerminal: (props: {
		terminalId: string;
		configDir: string;
		profileName: string;
		onClose: () => void;
		onAuthSuccess: (email?: string) => void;
	}) => (
		<section aria-label="auth-terminal" data-terminal={props.terminalId}>
			<span>{`${props.profileName} @ ${props.configDir}`}</span>
			<button type="button" onClick={props.onClose}>
				close-terminal
			</button>
			<button type="button" onClick={() => props.onAuthSuccess("a@b.c")}>
				finish-auth
			</button>
		</section>
	),
}));

const api = {
	getClaudeProfiles: vi.fn(),
	saveClaudeProfile: vi.fn(),
	deleteClaudeProfile: vi.fn(),
	renameClaudeProfile: vi.fn(),
	setActiveClaudeProfile: vi.fn(),
	authenticateClaudeProfile: vi.fn(),
	setClaudeProfileToken: vi.fn(),
};

const profile = (over: Partial<ClaudeProfile>): ClaudeProfile => ({
	id: "default",
	name: "Default",
	isDefault: true,
	createdAt: new Date(0),
	...over,
});
const signedIn = profile({ isAuthenticated: true, email: "me@example.test" });
const work = profile({ id: "work", name: "work", isDefault: false });

const loaded = (profiles: ClaudeProfile[], activeProfileId = "default") => ({
	success: true,
	data: { profiles, activeProfileId },
});

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	toast.mockReset();
	loadGlobalProfiles.mockReset();
	mac.value = false;
	Object.assign(globalThis, { electronAPI: api });
	api.getClaudeProfiles.mockResolvedValue(loaded([signedIn, work]));
});

async function renderStep() {
	const props = { onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn() };
	render(<OAuthStep {...props} />);
	await screen.findByText("oauth.multiAccountInfo");
	return props;
}

const row = (name: string) =>
	screen.getByText(name, { selector: "span" }).closest(".rounded-lg") as HTMLElement;
const alert = () => screen.getByText((_, el) => el?.className === "text-sm text-destructive");

describe("OAuthStep: the account list", () => {
	it("shows each account's state and lets the wizard move on once one is signed in", async () => {
		const props = await renderStep();
		const first = within(row("Default"));
		expect(first.getByText("oauth.badges.default")).toBeInTheDocument();
		expect(first.getByText("oauth.badges.active")).toBeInTheDocument();
		expect(first.getByText("oauth.badges.authenticated")).toBeInTheDocument();
		expect(first.getByText("me@example.test")).toBeInTheDocument();
		// The default account cannot be deleted, nor signed in again, nor made active again.
		expect(first.queryByTitle("common:accessibility.deleteProfileAriaLabel")).toBeNull();
		expect(first.queryByText("oauth.buttons.authenticate")).toBeNull();
		expect(first.queryByText("oauth.buttons.setActive")).toBeNull();

		const second = within(row("work"));
		expect(second.getByText("oauth.badges.needsAuth")).toBeInTheDocument();
		expect(second.getByText("oauth.buttons.setActive")).toBeInTheDocument();
		expect(screen.getByText("common:oauth.hasAuthenticatedAccount")).toBeInTheDocument();
		expect(screen.queryByText("oauth.keychainTitle")).toBeNull();
		expect(loadGlobalProfiles).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByText("oauth.buttons.continue"));
		fireEvent.click(screen.getByText("oauth.buttons.skip"));
		fireEvent.click(screen.getByText("oauth.buttons.back"));
		expect(props.onNext).toHaveBeenCalledOnce();
		expect(props.onSkip).toHaveBeenCalledOnce();
		expect(props.onBack).toHaveBeenCalledOnce();
	});

	it("keeps Continue off with no account, and explains the keychain on macOS", async () => {
		mac.value = true;
		api.getClaudeProfiles.mockResolvedValue(loaded([], ""));
		await renderStep();
		expect(screen.getByText("oauth.noAccountsYet")).toBeInTheDocument();
		expect(screen.getByText("oauth.keychainTitle")).toBeInTheDocument();
		expect(screen.getByText("oauth.buttons.continue")).toBeDisabled();
	});

	it.each([
		["a refusal with a reason", () => Promise.resolve({ success: false, error: "locked" }), "locked"],
		["a refusal without one", () => Promise.resolve({ success: true }), "oauth.errors.loadFailed"],
		["a thrown error", () => Promise.reject(new Error("ipc down")), "ipc down"],
		["a thrown value", () => Promise.reject("x"), "oauth.errors.loadFailed"],
	])("says when the accounts cannot be loaded: %s", async (_label, answer, shown) => {
		// A refused load used to leave the list silently empty.
		api.getClaudeProfiles.mockImplementation(answer);
		await renderStep();
		expect(alert()).toHaveTextContent(shown);
		expect(loadGlobalProfiles).not.toHaveBeenCalled();
	});
});

describe("OAuthStep: adding an account", () => {
	const nameInput = () => screen.getByPlaceholderText("common:oauth.accountNamePlaceholder");
	const typeName = (value: string) => fireEvent.change(nameInput(), { target: { value } });

	it("creates the account under a safe folder and opens its sign-in terminal", async () => {
		vi.spyOn(Date, "now").mockReturnValue(42);
		api.saveClaudeProfile.mockResolvedValue({ success: true, data: { id: "profile-42" } });
		api.authenticateClaudeProfile.mockResolvedValue({
			success: true,
			data: { terminalId: "t1", configDir: "/cfg/my-team" },
		});
		await renderStep();
		const add = screen.getByText("common:buttons.add").closest("button") as HTMLElement;
		expect(add).toBeDisabled();
		// Enter on an empty name does nothing.
		fireEvent.keyDown(nameInput(), { key: "Enter" });
		typeName("  My Team!  ");
		fireEvent.keyDown(nameInput(), { key: "a" });
		expect(api.saveClaudeProfile).not.toHaveBeenCalled();
		fireEvent.keyDown(nameInput(), { key: "Enter" });

		const terminal = await screen.findByRole("region", { name: "auth-terminal" });
		expect(api.saveClaudeProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "profile-42",
				name: "My Team!",
				configDir: "~/.claude-profiles/my-team",
				isDefault: false,
			}),
		);
		expect(api.authenticateClaudeProfile).toHaveBeenCalledWith("profile-42");
		expect(terminal).toHaveAttribute("data-terminal", "t1");
		expect(within(terminal).getByText("My Team! @ /cfg/my-team")).toBeInTheDocument();
		expect(nameInput()).toHaveValue("");
		expect(api.getClaudeProfiles).toHaveBeenCalledTimes(2);

		fireEvent.click(within(terminal).getByText("finish-auth"));
		await waitFor(() => expect(api.getClaudeProfiles).toHaveBeenCalledTimes(3));
		expect(screen.queryByRole("region", { name: "auth-terminal" })).toBeNull();
		vi.restoreAllMocks();
	});

	it("refuses a name with no letter or digit", async () => {
		await renderStep();
		typeName("!!!");
		fireEvent.click(screen.getByText("common:buttons.add"));
		expect(await screen.findByText("oauth.errors.invalidName")).toBeInTheDocument();
		expect(api.saveClaudeProfile).not.toHaveBeenCalled();
		expect(screen.getByText("common:buttons.add").closest("button")).toBeEnabled();
	});

	it.each([
		[{ success: false, error: "exists" }, "exists"],
		[{ success: true }, "oauth.errors.addFailed"],
	])("says when the account is not created (%o)", async (answer, shown) => {
		// A refused save used to clear nothing and say nothing.
		api.saveClaudeProfile.mockResolvedValue(answer);
		await renderStep();
		typeName("team");
		fireEvent.click(screen.getByText("common:buttons.add"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(api.authenticateClaudeProfile).not.toHaveBeenCalled();
		expect(nameInput()).toHaveValue("team");
	});

	it.each([
		[new Error("disk"), "disk"],
		["x", "oauth.errors.addFailed"],
	])("reports a failed save (%s) inline and as a toast", async (thrown, shown) => {
		api.saveClaudeProfile.mockRejectedValue(thrown);
		await renderStep();
		typeName("team");
		fireEvent.click(screen.getByText("common:buttons.add"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "oauth.toast.addProfileFailed" }),
		);
	});

	it.each([
		[{ success: false, error: "no pty" }, "oauth.alerts.profileCreatedAuthFailed:no pty"],
		[{ success: true }, "oauth.alerts.profileCreatedAuthFailed:oauth.toast.tryAgain"],
	])("keeps the new account when its sign-in cannot start (%o)", async (answer, title) => {
		api.saveClaudeProfile.mockResolvedValue({ success: true, data: { id: "p2" } });
		api.authenticateClaudeProfile.mockResolvedValue(answer);
		await renderStep();
		typeName("team");
		fireEvent.click(screen.getByText("common:buttons.add"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title })));
		expect(screen.queryByRole("region", { name: "auth-terminal" })).toBeNull();
	});
});

describe("OAuthStep: managing an account", () => {
	it("deletes an account and reloads the list", async () => {
		api.deleteClaudeProfile.mockResolvedValue({ success: true });
		await renderStep();
		fireEvent.click(within(row("work")).getByTitle("common:accessibility.deleteProfileAriaLabel"));
		await waitFor(() => expect(api.getClaudeProfiles).toHaveBeenCalledTimes(2));
		expect(api.deleteClaudeProfile).toHaveBeenCalledWith("work");
	});

	it.each([
		["refused", () => Promise.resolve({ success: false }), "oauth.errors.deleteFailed"],
		["refused with a reason", () => Promise.resolve({ success: false, error: "in use" }), "in use"],
		["thrown", () => Promise.reject(new Error("gone")), "gone"],
	])("says when a delete is %s", async (_label, answer, shown) => {
		api.deleteClaudeProfile.mockImplementation(answer);
		await renderStep();
		fireEvent.click(within(row("work")).getByTitle("common:accessibility.deleteProfileAriaLabel"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(api.getClaudeProfiles).toHaveBeenCalledOnce();
	});

	it("renames from the inline field, by button or Enter, and cancels with Escape", async () => {
		api.renameClaudeProfile.mockResolvedValue({ success: true });
		await renderStep();
		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		const field = screen.getByDisplayValue("work");
		fireEvent.change(field, { target: { value: "  zeta " } });
		// The avatar follows the name being typed.
		expect(screen.getByText("Z")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "common:accessibility.saveEditAriaLabel" }));
		await waitFor(() => expect(api.renameClaudeProfile).toHaveBeenCalledWith("work", "zeta"));
		await waitFor(() => expect(screen.queryByDisplayValue("  zeta ")).toBeNull());

		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		fireEvent.keyDown(screen.getByDisplayValue("work"), { key: "Escape" });
		expect(screen.queryByDisplayValue("work")).toBeNull();

		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		fireEvent.click(screen.getByRole("button", { name: "common:accessibility.cancelEditAriaLabel" }));
		expect(screen.queryByDisplayValue("work")).toBeNull();

		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		fireEvent.keyDown(screen.getByDisplayValue("work"), { key: "a" });
		fireEvent.keyDown(screen.getByDisplayValue("work"), { key: "Enter" });
		await waitFor(() => expect(api.renameClaudeProfile).toHaveBeenLastCalledWith("work", "work"));
	});

	it("ignores a blank new name", async () => {
		await renderStep();
		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		fireEvent.change(screen.getByDisplayValue("work"), { target: { value: "   " } });
		const raw = { normalizer: (value: string) => value };
		fireEvent.keyDown(screen.getByDisplayValue("   ", raw), { key: "Enter" });
		expect(api.renameClaudeProfile).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("   ", raw)).toBeInTheDocument();
	});

	it.each([
		["refused", () => Promise.resolve({ success: false }), "oauth.errors.renameFailed"],
		["thrown", () => Promise.reject("x"), "oauth.errors.renameFailed"],
	])("says when a rename is %s and leaves edit mode", async (_label, answer, shown) => {
		api.renameClaudeProfile.mockImplementation(answer);
		await renderStep();
		fireEvent.click(within(row("work")).getByTitle("common:accessibility.renameProfileAriaLabel"));
		fireEvent.keyDown(screen.getByDisplayValue("work"), { key: "Enter" });
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(screen.queryByDisplayValue("work")).toBeNull();
	});

	it("makes another account active", async () => {
		api.setActiveClaudeProfile.mockResolvedValue({ success: true });
		await renderStep();
		fireEvent.click(within(row("work")).getByText("oauth.buttons.setActive"));
		await waitFor(() =>
			expect(within(row("work")).getByText("oauth.badges.active")).toBeInTheDocument(),
		);
		expect(api.setActiveClaudeProfile).toHaveBeenCalledWith("work");
		expect(loadGlobalProfiles).toHaveBeenCalledTimes(2);
		expect(within(row("Default")).getByText("oauth.buttons.setActive")).toBeInTheDocument();
	});

	it.each([
		["refused", () => Promise.resolve({ success: false }), "oauth.errors.setActiveFailed"],
		["thrown", () => Promise.reject(new Error("busy")), "busy"],
	])("says when switching accounts is %s", async (_label, answer, shown) => {
		api.setActiveClaudeProfile.mockImplementation(answer);
		await renderStep();
		fireEvent.click(within(row("work")).getByText("oauth.buttons.setActive"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(within(row("Default")).getByText("oauth.badges.active")).toBeInTheDocument();
	});
});

describe("OAuthStep: signing an account in", () => {
	it("opens the terminal for that account, then closes it on demand", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.authenticateClaudeProfile.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		await renderStep();
		const button = within(row("work")).getByText("oauth.buttons.authenticate").closest("button");
		fireEvent.click(button as HTMLElement);
		expect(button).toBeDisabled();
		await act(async () => answer({ success: true, data: { terminalId: "t9", configDir: "/w" } }));
		const terminal = screen.getByRole("region", { name: "auth-terminal" });
		expect(within(terminal).getByText("work @ /w")).toBeInTheDocument();

		fireEvent.click(within(terminal).getByText("close-terminal"));
		expect(screen.queryByRole("region", { name: "auth-terminal" })).toBeNull();
		expect(button).toBeEnabled();
	});

	it.each([
		[{ success: false, error: "no shell" }, "oauth.alerts.authPrepareFailed:no shell"],
		[{ success: true }, "oauth.alerts.authPrepareFailed:oauth.toast.tryAgain"],
	])("says when the sign-in cannot be prepared (%o)", async (result, title) => {
		api.authenticateClaudeProfile.mockResolvedValue(result);
		await renderStep();
		fireEvent.click(within(row("work")).getByText("oauth.buttons.authenticate"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title })));
		expect(within(row("work")).getByText("oauth.buttons.authenticate").closest("button")).toBeEnabled();
	});

	it("says when the sign-in fails to start", async () => {
		api.authenticateClaudeProfile.mockRejectedValue("x");
		await renderStep();
		fireEvent.click(within(row("work")).getByText("oauth.buttons.authenticate"));
		expect(await screen.findByText("oauth.errors.authFailed")).toBeInTheDocument();
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "oauth.alerts.authStartFailedMessage" }),
		);
	});
});

describe("OAuthStep: pasting a token", () => {
	const openEntry = (name: string) =>
		fireEvent.click(within(row(name)).getByTitle("common:accessibility.enterTokenManuallyAriaLabel"));
	const tokenField = () => screen.getByPlaceholderText("sk-ant-oat01-...");
	const emailField = () => screen.getByPlaceholderText("common:oauth.emailOptionalPlaceholder");
	const save = () => screen.getByText("common:oauth.saveToken").closest("button") as HTMLElement;

	it("saves a pasted token with its email, then closes the entry", async () => {
		api.setClaudeProfileToken.mockResolvedValue({ success: true });
		await renderStep();
		openEntry("work");
		expect(screen.getByText("common:oauth.tokenCommandHint")).toBeInTheDocument();
		expect(save()).toBeDisabled();
		fireEvent.change(tokenField(), { target: { value: " tok-test-0000 " } });
		fireEvent.change(emailField(), { target: { value: " me@example.test " } });

		expect(tokenField()).toHaveAttribute("type", "password");
		fireEvent.click(screen.getByRole("button", { name: "oauth.buttons.showToken" }));
		expect(tokenField()).toHaveAttribute("type", "text");
		fireEvent.click(screen.getByRole("button", { name: "oauth.buttons.hideToken" }));
		expect(tokenField()).toHaveAttribute("type", "password");

		fireEvent.click(save());
		await waitFor(() => expect(screen.queryByPlaceholderText("sk-ant-oat01-...")).toBeNull());
		expect(api.setClaudeProfileToken).toHaveBeenCalledWith("work", "tok-test-0000", "me@example.test");
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "oauth.toast.tokenSaved" }));
	});

	it("leaves the email out when none is given", async () => {
		api.setClaudeProfileToken.mockResolvedValue({ success: false });
		await renderStep();
		openEntry("work");
		fireEvent.change(tokenField(), { target: { value: "tok-test-0000" } });
		fireEvent.click(save());
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "oauth.toast.tokenSaveFailed",
					description: "oauth.toast.tryAgain",
				}),
			),
		);
		expect(api.setClaudeProfileToken).toHaveBeenCalledWith("work", "tok-test-0000", undefined);
		// A refused token keeps the entry open with what was typed.
		expect(tokenField()).toHaveValue("tok-test-0000");
		expect(save()).toBeEnabled();
	});

	it("passes on the reason a token is refused", async () => {
		api.setClaudeProfileToken.mockResolvedValue({ success: false, error: "expired" });
		await renderStep();
		openEntry("work");
		fireEvent.change(tokenField(), { target: { value: "tok-test-0000" } });
		fireEvent.click(save());
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: "expired" })),
		);
	});

	it("reports a failed save inline and as a toast", async () => {
		api.setClaudeProfileToken.mockRejectedValue(new Error("vault locked"));
		await renderStep();
		openEntry("work");
		fireEvent.change(tokenField(), { target: { value: "tok-test-0000" } });
		fireEvent.click(save());
		expect(await screen.findByText("vault locked")).toBeInTheDocument();
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "oauth.toast.tokenSaveFailed", description: "oauth.toast.tryAgain" }),
		);
	});

	it("starts every entry empty and hidden, and closes from Cancel or the toggle", async () => {
		await renderStep();
		openEntry("work");
		fireEvent.change(tokenField(), { target: { value: "tok-test-0000" } });
		fireEvent.click(screen.getByRole("button", { name: "oauth.buttons.showToken" }));
		openEntry("Default");
		expect(tokenField()).toHaveValue("");
		expect(tokenField()).toHaveAttribute("type", "password");

		fireEvent.click(within(row("Default")).getByTitle("common:accessibility.hideTokenEntryAriaLabel"));
		expect(screen.queryByPlaceholderText("sk-ant-oat01-...")).toBeNull();

		openEntry("work");
		fireEvent.click(screen.getByText("common:buttons.cancel"));
		expect(screen.queryByPlaceholderText("sk-ant-oat01-...")).toBeNull();
	});
});
