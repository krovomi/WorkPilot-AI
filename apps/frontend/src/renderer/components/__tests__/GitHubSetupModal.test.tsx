/**
 * @vitest-environment jsdom
 */
/**
 * The GitHub setup flow shown after a project is initialised: it skips the
 * sign-ins already done, confirms or creates or links the repository, and
 * ends on a base branch.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubSetupModal } from "../GitHubSetupModal";

// The two sign-in flows have their own tests; here they only report success.
vi.mock("../project-settings/GitHubOAuthFlow", () => ({
	GitHubOAuthFlow: ({ onSuccess }: { onSuccess: (token: string) => void }) => (
		<button type="button" onClick={() => onSuccess("gho_new")}>
			github-signed-in
		</button>
	),
}));
vi.mock("../project-settings/ClaudeOAuthFlow", () => ({
	ClaudeOAuthFlow: ({ onSuccess }: { onSuccess: () => void }) => (
		<button type="button" onClick={() => onSuccess()}>
			claude-signed-in
		</button>
	),
}));

const api = {
	getGitHubToken: vi.fn(),
	getClaudeProfiles: vi.fn(),
	detectGitHubRepo: vi.fn(),
	getGitHubUser: vi.fn(),
	listGitHubOrgs: vi.fn(),
	getGitHubBranches: vi.fn(),
	createGitHubRepo: vi.fn(),
	addGitRemote: vi.fn(),
};

const project = { id: "p1", name: "My App!", path: "/work/my-app" } as never;

const signedInClaude = {
	success: true,
	data: { activeProfileId: "a", profiles: [{ id: "a", oauthToken: "••••" }] },
};

function renderModal(onSkip: (() => void) | undefined = vi.fn()) {
	const onComplete = vi.fn();
	const view = render(
		<GitHubSetupModal
			open
			onOpenChange={vi.fn()}
			project={project}
			onComplete={onComplete}
			onSkip={onSkip}
		/>,
	);
	return { ...view, onComplete, onSkip };
}

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.getGitHubToken.mockResolvedValue({ success: false });
	api.getClaudeProfiles.mockResolvedValue({ success: true, data: { profiles: [] } });
	api.detectGitHubRepo.mockResolvedValue({ success: true, data: "octo/my-app" });
	api.getGitHubUser.mockResolvedValue({ success: true, data: { username: "octo" } });
	api.listGitHubOrgs.mockResolvedValue({
		success: true,
		data: { orgs: [{ login: "acme" }] },
	});
	api.getGitHubBranches.mockResolvedValue({
		success: true,
		data: ["feature/x", "develop", "main"],
	});
});

describe("GitHubSetupModal sign-in", () => {
	it("opens once, without looping, on the GitHub step", async () => {
		renderModal();
		expect(await screen.findByText("Connect to GitHub")).toBeInTheDocument();
		await waitFor(() => expect(api.getGitHubToken).toHaveBeenCalledTimes(1));
		// A render loop would call it again and again.
		await new Promise((r) => setTimeout(r, 50));
		expect(api.getGitHubToken).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Authenticate")).toBeInTheDocument();
	});

	it("goes from GitHub to Claude to the detected repository", async () => {
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "github-signed-in" }));
		fireEvent.click(await screen.findByRole("button", { name: "claude-signed-in" }));
		expect(await screen.findByText("Repository Detected")).toBeInTheDocument();
		expect(api.detectGitHubRepo).toHaveBeenCalledWith("/work/my-app");
	});

	it("skips Claude when its account is already signed in", async () => {
		api.getClaudeProfiles.mockResolvedValue(signedInClaude);
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "github-signed-in" }));
		expect(await screen.findByText("Repository Detected")).toBeInTheDocument();
		expect(screen.queryByText("claude-signed-in")).toBeNull();
	});

	it("shows Claude when its profile check fails", async () => {
		renderModal();
		api.getClaudeProfiles.mockRejectedValue(new Error("ipc"));
		fireEvent.click(await screen.findByRole("button", { name: "github-signed-in" }));
		expect(await screen.findByText("Connect to Claude AI")).toBeInTheDocument();
	});

	it("starts at Claude when only GitHub is signed in", async () => {
		api.getGitHubToken.mockResolvedValue({ success: true, data: { token: "gho_1" } });
		renderModal();
		expect(await screen.findByText("Connect to Claude AI")).toBeInTheDocument();
	});

	it("starts at the repository when both are signed in", async () => {
		api.getGitHubToken.mockResolvedValue({ success: true, data: { token: "gho_1" } });
		api.getClaudeProfiles.mockResolvedValue({
			success: true,
			data: {
				activeProfileId: "d",
				profiles: [{ id: "d", isDefault: true, configDir: "/home/.claude" }],
			},
		});
		renderModal();
		expect(await screen.findByText("Repository Detected")).toBeInTheDocument();
		expect(screen.getByText("octo/my-app")).toBeInTheDocument();
	});

	it("starts over when the sign-in check throws", async () => {
		api.getGitHubToken.mockRejectedValue(new Error("down"));
		renderModal();
		expect(await screen.findByText("Connect to GitHub")).toBeInTheDocument();
	});
});

describe("GitHubSetupModal repository and branch", () => {
	beforeEach(() => {
		api.getGitHubToken.mockResolvedValue({ success: true, data: { token: "gho_1" } });
		api.getClaudeProfiles.mockResolvedValue(signedInClaude);
	});

	it("confirms the detected repository, recommends main and completes", async () => {
		const { onComplete } = renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Confirm & Continue/ }));
		expect(await screen.findByText("Select Base Branch")).toBeInTheDocument();
		await waitFor(() =>
			expect(api.getGitHubBranches).toHaveBeenCalledWith("octo/my-app", "gho_1"),
		);
		expect(await screen.findByText("Recommended")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Complete Setup/ }));
		expect(onComplete).toHaveBeenCalledWith({
			githubToken: "gho_1",
			githubRepo: "octo/my-app",
			mainBranch: "main",
			githubAuthMethod: "oauth",
		});
		expect(screen.getByText("Configure")).toBeInTheDocument();
	});

	it("recommends develop, then the first branch, when there is no main", async () => {
		api.getGitHubBranches.mockResolvedValueOnce({ success: true, data: ["x", "develop"] });
		const { onComplete } = renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Confirm & Continue/ }));
		await screen.findByText("Recommended");
		fireEvent.click(screen.getByRole("button", { name: /Complete Setup/ }));
		expect(onComplete.mock.calls[0][0].mainBranch).toBe("develop");
	});

	it("shows why the branches did not load", async () => {
		api.getGitHubBranches
			.mockResolvedValueOnce({ success: false, error: "rate limited" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("offline"));
		for (const message of ["rate limited", "Could not load the branches.", "offline"]) {
			const view = renderModal();
			fireEvent.click(await screen.findByRole("button", { name: /Confirm & Continue/ }));
			expect(await screen.findByText(message)).toBeInTheDocument();
			view.unmount();
		}
	});

	it("falls back to a translated message for a thrown branch error", async () => {
		api.getGitHubBranches.mockRejectedValueOnce("raw");
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Confirm & Continue/ }));
		expect(await screen.findByText("Could not load the branches.")).toBeInTheDocument();
	});

	it("creates a repository under an organisation, keeping what is typed", async () => {
		api.createGitHubRepo.mockResolvedValue({
			success: true,
			data: { fullName: "acme/web-app" },
		});
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: /Use Different Repository/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Create new repository on GitHub" }));
		const name = screen.getByLabelText("Repository Name") as HTMLInputElement;
		// The project name, made safe for GitHub.
		expect(name.value).toBe("My-App-");
		const user = userEvent.setup();
		await user.clear(name);
		await user.type(name, "web-app");
		// The field keeps its focus and every key while typing.
		const typed = screen.getByLabelText("Repository Name") as HTMLInputElement;
		expect(typed.value).toBe("web-app");
		expect(typed).toHaveFocus();
		fireEvent.click(await screen.findByRole("radio", { name: "Select acme as repository owner" }));
		fireEvent.click(screen.getByRole("radio", { name: /visibility to Public/ }));
		fireEvent.click(screen.getByRole("button", { name: /Create Repository/ }));
		expect(await screen.findByText("Select Base Branch")).toBeInTheDocument();
		expect(api.createGitHubRepo).toHaveBeenCalledWith("web-app", {
			isPrivate: false,
			projectPath: "/work/my-app",
			owner: "acme",
		});
		expect(screen.getByText("acme/web-app")).toBeInTheDocument();
	});

	it("creates under the personal account without naming an owner", async () => {
		api.detectGitHubRepo.mockResolvedValue({ success: false });
		api.createGitHubRepo.mockResolvedValue({ success: true, data: { fullName: "octo/My-App-" } });
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Create new repository on GitHub" }));
		await screen.findByRole("radio", { name: "Select octo as repository owner" });
		fireEvent.click(screen.getByRole("button", { name: /Create Repository/ }));
		await waitFor(() => expect(api.createGitHubRepo).toHaveBeenCalled());
		expect(api.createGitHubRepo.mock.calls[0][1]).toEqual({
			isPrivate: true,
			projectPath: "/work/my-app",
			owner: undefined,
		});
	});

	it("checks the repository name and owner before creating", async () => {
		api.detectGitHubRepo.mockResolvedValue({ success: false });
		api.getGitHubUser.mockResolvedValue({ success: false });
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Create new repository on GitHub" }));
		fireEvent.click(screen.getByRole("button", { name: /Create Repository/ }));
		expect(await screen.findByText("Choose who owns the repository.")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Repository Name"), { target: { value: "  " } });
		expect(screen.getByRole("button", { name: /Create Repository/ })).toBeDisabled();
		expect(api.createGitHubRepo).not.toHaveBeenCalled();
	});

	it("shows why the repository was not created", async () => {
		api.detectGitHubRepo.mockResolvedValue({ success: false });
		api.createGitHubRepo
			.mockResolvedValueOnce({ success: false, error: "name taken" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("gh crashed"))
			.mockRejectedValueOnce("raw");
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Create new repository on GitHub" }));
		await screen.findByRole("radio", { name: "Select octo as repository owner" });
		for (const message of [
			"name taken",
			"Could not create the repository.",
			"gh crashed",
			"Could not create the repository.",
		]) {
			fireEvent.click(screen.getByRole("button", { name: /Create Repository/ }));
			expect(await screen.findByText(message)).toBeInTheDocument();
		}
	});

	it("links an existing repository after checking its form", async () => {
		api.detectGitHubRepo.mockResolvedValue({ success: false });
		api.addGitRemote.mockResolvedValue({ success: true });
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Link to existing repository" }));
		expect(screen.getByRole("button", { name: /Link Repository/ })).toBeDisabled();
		const field = screen.getByLabelText("Repository");
		fireEvent.change(field, { target: { value: "not a repo" } });
		fireEvent.click(screen.getByRole("button", { name: /Link Repository/ }));
		expect(
			await screen.findByText("Use the owner/repo form, for example username/my-project."),
		).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Repository"), { target: { value: " octo/hello " } });
		fireEvent.click(screen.getByRole("button", { name: /Link Repository/ }));
		expect(await screen.findByText("Select Base Branch")).toBeInTheDocument();
		expect(api.addGitRemote).toHaveBeenCalledWith("/work/my-app", "octo/hello");
	});

	it("shows why the remote was not added", async () => {
		api.detectGitHubRepo.mockResolvedValue({ success: false });
		api.addGitRemote
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("remote exists"))
			.mockRejectedValueOnce("raw");
		renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Link to existing repository" }));
		fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "octo/hello" } });
		fireEvent.click(screen.getByRole("button", { name: /Link Repository/ }));
		expect(await screen.findByText("Could not add the remote.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Link Repository/ }));
		expect(await screen.findByText("remote exists")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Link Repository/ }));
		expect(await screen.findByText("Could not add the remote.")).toBeInTheDocument();
		expect(screen.queryByText("raw")).toBeNull();
	});

	it("goes back from a form and retries the detection", async () => {
		api.detectGitHubRepo
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("no git"));
		const { onSkip } = renderModal();
		fireEvent.click(await screen.findByRole("button", { name: "Link to existing repository" }));
		fireEvent.click(screen.getByRole("button", { name: "Go back to repository selection" }));
		fireEvent.click(await screen.findByRole("button", { name: /Retry Detection/ }));
		expect(await screen.findByText("no git")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Skip for now/ }));
		expect(onSkip).toHaveBeenCalled();
	});

	it("words a detection that rejects with something other than an Error", async () => {
		api.detectGitHubRepo.mockRejectedValueOnce("raw");
		renderModal();
		expect(await screen.findByText("Could not detect the repository.")).toBeInTheDocument();
	});
});
