/**
 * @vitest-environment jsdom
 */
/**
 * The dialog that asks for the GitHub repository and token of a new project:
 * format checks while typing, the connection test and what its failures mean,
 * saving, and closing.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { GitHubRemoteConfigModal } from "../GitHubRemoteConfigModal";

// Obvious fakes: only their prefix matters to the dialog.
const CLASSIC = "ghp_fake_classic_token";
const FINE = "github_pat_fake_fine_token";

const api = { testGitHubConnection: vi.fn() };

function show(initialConfig?: { repo?: string; token?: string }) {
	const onSave = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<GitHubRemoteConfigModal open onOpenChange={onOpenChange} onSave={onSave} initialConfig={initialConfig} />,
	);
	return { onSave, onOpenChange };
}

const repoField = () => screen.getByLabelText("Repository");
const tokenField = () => screen.getByLabelText("GitHub Token");
const testButton = () => screen.getByRole("button", { name: "Test Connection" });
const saveButton = () => screen.getByRole("button", { name: "Validate" });

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	api.testGitHubConnection.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GitHubRemoteConfigModal", () => {
	it("asks for both fields before anything can be tested or saved", () => {
		show();
		expect(screen.getByRole("dialog", { name: "Configure GitHub" })).toBeInTheDocument();
		expect(screen.getByText("Please fill all fields")).toBeInTheDocument();
		expect(testButton()).toBeDisabled();
		expect(saveButton()).toBeDisabled();
		expect(tokenField()).toHaveAttribute("type", "password");
	});

	it("checks the formats while typing", async () => {
		const user = userEvent.setup();
		show();
		await user.type(repoField(), "not a repo");
		expect(screen.getByText("Invalid format. Use format: owner/repo")).toBeInTheDocument();
		await user.clear(repoField());
		expect(screen.getByText("Repository is required")).toBeInTheDocument();
		await user.type(tokenField(), "abc");
		expect(screen.getByText(/Invalid token format/)).toBeInTheDocument();
		await user.clear(tokenField());
		expect(screen.getByText("GitHub token is required")).toBeInTheDocument();
		await user.type(repoField(), "acme/shop");
		await user.type(tokenField(), CLASSIC);
		expect(screen.queryByText(/required|Invalid/)).toBeNull();
		expect(screen.getByText("Ready to save")).toBeInTheDocument();
	});

	it("says to fix the errors while one is shown", async () => {
		const user = userEvent.setup();
		show();
		await user.type(repoField(), "acme");
		await user.type(tokenField(), CLASSIC);
		expect(screen.getByText("Fix errors to continue")).toBeInTheDocument();
		expect(saveButton()).toBeDisabled();
		expect(testButton()).toBeDisabled();
	});

	it("tells which permissions each kind of token needs", async () => {
		const user = userEvent.setup();
		show();
		await user.type(tokenField(), CLASSIC);
		expect(screen.getByText("Classic Token detected")).toBeInTheDocument();
		expect(screen.getByText(/'repo' scope for full repository access/)).toBeInTheDocument();
		await user.clear(tokenField());
		await user.type(tokenField(), `  ${FINE}`);
		expect(screen.getByText("Fine-grained Token detected")).toBeInTheDocument();
		expect(screen.getByText(/Contents: Read, Metadata: Read/)).toBeInTheDocument();
	});

	it("tests the connection with the trimmed values and says it works", async () => {
		const user = userEvent.setup();
		let finish!: (value: { success: boolean }) => void;
		api.testGitHubConnection.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		show({ repo: " acme/shop ", token: ` ${CLASSIC} ` });
		await user.click(testButton());
		expect(screen.getByRole("button", { name: "Testing in progress..." })).toBeDisabled();
		expect(api.testGitHubConnection).toHaveBeenCalledWith({ repo: "acme/shop", token: CLASSIC });
		await act(async () => finish({ success: true }));
		expect(screen.getByText("GitHub connection successful!")).toBeInTheDocument();
		expect(screen.getByText("Connection verified")).toBeInTheDocument();
	});

	it.each([
		["a classic token without rights", CLASSIC, { success: false, status: 403 }, /classic token has 'repo' scope/],
		["a fine-grained token without rights", FINE, { success: false, status: 403 }, /fine-grained token has 'Contents: Read'/],
		["a repository it cannot see", CLASSIC, { success: false, status: 404 }, /^Repository not found/],
		["GitHub's own reason", CLASSIC, { success: false, status: 500, error: "Bad credentials" }, /^Bad credentials$/],
		["a failure without a reason", CLASSIC, { success: false }, /^Failed to connect to GitHub$/],
	])("explains %s", async (_name, token, result, text) => {
		const user = userEvent.setup();
		api.testGitHubConnection.mockResolvedValueOnce(result);
		show({ repo: "acme/shop", token });
		await user.click(testButton());
		expect(await screen.findByText(text)).toBeInTheDocument();
		expect(screen.getByText("Ready to save")).toBeInTheDocument();
	});

	it("says when the test could not reach GitHub", async () => {
		const user = userEvent.setup();
		api.testGitHubConnection.mockRejectedValueOnce(new Error("offline"));
		show({ repo: "acme/shop", token: CLASSIC });
		await user.click(testButton());
		expect(await screen.findByText("Network error during connection test")).toBeInTheDocument();
		expect(testButton()).toBeEnabled();
	});

	it("forgets a result once the values it was about change", async () => {
		const user = userEvent.setup();
		show({ repo: "acme/shop", token: CLASSIC });
		await user.click(testButton());
		expect(await screen.findByText("GitHub connection successful!")).toBeInTheDocument();
		await user.type(tokenField(), "x");
		expect(screen.queryByText("GitHub connection successful!")).toBeNull();
		expect(screen.getByText("Ready to save")).toBeInTheDocument();
	});

	it("drops the answer of a test sent with values changed since", async () => {
		let finish!: (value: { success: boolean }) => void;
		api.testGitHubConnection.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		show({ repo: "acme/shop", token: CLASSIC });
		fireEvent.click(testButton());
		fireEvent.change(repoField(), { target: { value: "acme/other" } });
		await act(async () => finish({ success: true }));
		expect(screen.queryByText("GitHub connection successful!")).toBeNull();
		expect(screen.getByText("Ready to save")).toBeInTheDocument();
		expect(testButton()).toBeEnabled();
	});

	it("refuses to test or save values it was given in a wrong format", async () => {
		const user = userEvent.setup();
		const { onSave } = show({ repo: "acme", token: "abc" });
		await user.click(testButton());
		expect(api.testGitHubConnection).not.toHaveBeenCalled();
		expect(screen.getByText("Invalid format. Use format: owner/repo")).toBeInTheDocument();
		expect(screen.getByText(/Invalid token format/)).toBeInTheDocument();
		expect(saveButton()).toBeDisabled();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("says why it does not save a given value in a wrong format, until it is fixed", async () => {
		const user = userEvent.setup();
		const { onSave } = show({ repo: "acme", token: CLASSIC });
		await user.click(saveButton());
		expect(screen.getByRole("alert")).toHaveTextContent("Please correct errors before continuing.");
		expect(onSave).not.toHaveBeenCalled();
		// Fixing the value takes the alert away.
		await user.type(repoField(), "/shop");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("saves the trimmed values and closes", async () => {
		const user = userEvent.setup();
		const { onSave, onOpenChange } = show();
		await user.type(repoField(), " acme/shop ");
		await user.type(tokenField(), FINE);
		await user.click(saveButton());
		expect(onSave).toHaveBeenCalledWith({ repo: "acme/shop", token: FINE });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes from its close button but not from Escape or a click outside", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = show();
		await user.keyboard("{Escape}");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		// The page behind the modal is inert: the press outside is sent to it directly.
		fireEvent.pointerDown(document.body);
		fireEvent.click(document.body);
		expect(onOpenChange).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
