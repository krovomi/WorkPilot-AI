/**
 * GitHubIntegration — a project's GitHub settings: a token typed by hand or
 * got from the GitHub login (which then lists the person's repositories), the
 * repository, the default branch (detected when none is set) and the sync.
 * A token saved from the login reopens on its repository list.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule } from "../../../../../__tests__/helpers/stub-component";
import i18n from "../../../../../shared/i18n";
import type { GitHubSyncStatus, ProjectEnvConfig, ProjectSettings } from "../../../../../shared/types";
import { GitHubIntegration } from "../GitHubIntegration";

vi.mock("../../../project-settings/GitHubOAuthFlow", () => stubModule("GitHubOAuthFlow"));

const REPOS = [
	{ fullName: "acme/api", description: "The API", isPrivate: true },
	{ fullName: "acme/site", description: null, isPrivate: false },
];
const BRANCHES = [
	{ name: "main", type: "local", displayName: "main" },
	{ name: "origin/develop", type: "remote", displayName: "origin/develop" },
];

let api: RendererApi;

beforeEach(() => {
	api = installRendererApi({
		getGitBranchesWithInfo: vi.fn(async () => ({ success: true, data: BRANCHES })),
		detectMainBranch: vi.fn(async () => ({ success: true, data: "main" })),
		listGitHubUserRepos: vi.fn(async () => ({ success: true, data: { repos: REPOS } })),
	});
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderGitHub(
	env: Partial<ProjectEnvConfig> | null = {},
	options: { status?: GitHubSyncStatus | null; checking?: boolean; projectPath?: string; settings?: Partial<ProjectSettings> } = {},
) {
	const updateEnvConfig = vi.fn();
	const setSettings = vi.fn();
	const props = {
		envConfig: env === null ? null : ({ githubEnabled: true, ...env } as ProjectEnvConfig),
		updateEnvConfig,
		showGitHubToken: false,
		setShowGitHubToken: vi.fn(),
		gitHubConnectionStatus: options.status ?? null,
		isCheckingGitHub: options.checking ?? false,
		projectPath: "projectPath" in options ? options.projectPath : "/p",
		settings: options.settings as ProjectSettings | undefined,
		setSettings,
	};
	const view = render(<GitHubIntegration {...props} />);
	return { updateEnvConfig, setSettings, props, ...view };
}

describe("GitHubIntegration", () => {
	it("shows nothing without the project's configuration, and only the switch while GitHub is off", async () => {
		const { container } = renderGitHub(null);
		expect(container).toBeEmptyDOMElement();
		cleanup();
		const { updateEnvConfig } = renderGitHub({ githubEnabled: false });
		await userEvent.click(screen.getByRole("switch", { name: "Enable GitHub Issues" }));
		expect(updateEnvConfig).toHaveBeenCalledWith({ githubEnabled: true });
		expect(screen.queryByLabelText("Personal Access Token")).toBeNull();
		expect(globalThis.electronAPI.getGitBranchesWithInfo).not.toHaveBeenCalled();
	});

	it("takes a token and a repository typed by hand, and shows the connection", async () => {
		const { updateEnvConfig, rerender, props } = renderGitHub({ githubToken: "", githubRepo: "" });
		await userEvent.type(screen.getByLabelText("Personal Access Token"), "x");
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ githubToken: "x" });
		await userEvent.type(screen.getByLabelText("Repository"), "a");
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ githubRepo: "a" });
		await userEvent.click(screen.getByRole("switch", { name: "Auto-Sync on Load" }));
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ githubAutoSync: true });
		expect(screen.queryByText("Connection Status")).toBeNull();

		const filled = { ...props.envConfig, githubToken: "••••", githubRepo: "acme/api" } as ProjectEnvConfig;
		rerender(<GitHubIntegration {...props} envConfig={filled} isCheckingGitHub />);
		expect(screen.getByText("Checking connection...")).toBeInTheDocument();
		rerender(<GitHubIntegration {...props} envConfig={filled} gitHubConnectionStatus={{ connected: false } as GitHubSyncStatus} />);
		expect(screen.getByText("Not connected to GitHub")).toBeInTheDocument();
		rerender(
			<GitHubIntegration
				{...props}
				envConfig={filled}
				gitHubConnectionStatus={{ connected: true, repoFullName: "acme/api", repoDescription: "The API" } as GitHubSyncStatus}
			/>,
		);
		expect(screen.getByText("Connected to GitHub")).toBeInTheDocument();
		expect(screen.getByText("The API")).toBeInTheDocument();
		expect(screen.getByText("Issues Available")).toBeInTheDocument();
	});

	it("signs in with GitHub, lists the person's repositories and picks one", async () => {
		const { updateEnvConfig } = renderGitHub({ githubRepo: "acme/api" });
		await userEvent.click(screen.getByRole("button", { name: "Use OAuth Instead" }));
		expect(screen.getByText("GitHub Authentication")).toBeInTheDocument();
		act(() => {
			callStub("GitHubOAuthFlow", "onCancel");
		});
		expect(screen.getByLabelText("Personal Access Token")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Use OAuth Instead" }));
		await act(async () => {
			callStub("GitHubOAuthFlow", "onSuccess", "gho_test", "octocat");
		});
		expect(updateEnvConfig).toHaveBeenCalledWith({ githubToken: "gho_test", githubAuthMethod: "oauth" });
		expect(screen.getByText("Authenticated as octocat")).toBeInTheDocument();
		const picker = await screen.findByRole("button", { name: /acme\/api/ });
		expect(screen.getByText("Selected:", { exact: false })).toBeInTheDocument();

		await userEvent.click(picker);
		await userEvent.type(screen.getByPlaceholderText("Search repositories..."), "nothing");
		expect(screen.getByText("No matching repositories")).toBeInTheDocument();
		await userEvent.clear(screen.getByPlaceholderText("Search repositories..."));
		await userEvent.type(screen.getByPlaceholderText("Search repositories..."), "site");
		await userEvent.click(screen.getByRole("button", { name: "acme/site" }));
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ githubRepo: "acme/site" });
		expect(screen.queryByPlaceholderText("Search repositories...")).toBeNull();

		// Back to a token typed by hand.
		await userEvent.click(screen.getByRole("button", { name: "Enter Manually" }));
		expect(screen.getByLabelText("Personal Access Token")).toBeInTheDocument();
	});

	it("reopens a token from the login on its repository list, and says when the list cannot be read", async () => {
		(globalThis.electronAPI.listGitHubUserRepos as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ success: false, error: "Bad credentials" })
			.mockRejectedValueOnce(new Error("IPC"))
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, data: { repos: [] } });
		renderGitHub({ githubToken: "••••", githubAuthMethod: "oauth" });
		expect(screen.getByText("Connected via GitHub CLI")).toBeInTheDocument();
		expect(await screen.findByText("Bad credentials")).toBeInTheDocument();
		const refresh = () => screen.getAllByRole("button", { name: "Refresh" })[0];
		await userEvent.click(refresh());
		expect(await screen.findByText("IPC")).toBeInTheDocument();
		await userEvent.click(refresh());
		expect(await screen.findByText("Failed to load repositories")).toBeInTheDocument();
		await userEvent.click(refresh());
		await waitFor(() => expect(screen.queryByText("Failed to load repositories")).toBeNull());
		await userEvent.click(screen.getByRole("button", { name: /Select a repository/ }));
		expect(screen.getByText("No repositories found")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Use Different Token" }));
		expect(screen.getByLabelText("Personal Access Token")).toBeInTheDocument();
	});

	it("detects the default branch when none is set, and saves the one picked", async () => {
		const { updateEnvConfig, setSettings } = renderGitHub();
		await waitFor(() => expect(updateEnvConfig).toHaveBeenCalledWith({ defaultBranch: "main" }));
		expect(globalThis.electronAPI.getGitBranchesWithInfo).toHaveBeenCalledWith("/p");
		const update = setSettings.mock.calls[0][0] as (prev: ProjectSettings) => ProjectSettings;
		expect(update({ mainBranch: "x" } as ProjectSettings).mainBranch).toBe("main");

		await userEvent.click(screen.getByRole("combobox"));
		await userEvent.click(screen.getByRole("option", { name: /origin\/develop/ }));
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ defaultBranch: "origin/develop" });
	});

	it("keeps the branch already chosen, and says when branches cannot be read", async () => {
		const { updateEnvConfig } = renderGitHub({}, { settings: { mainBranch: "develop" } });
		await waitFor(() => expect(screen.getByText("Pull requests will target develop.")).toBeInTheDocument());
		expect(globalThis.electronAPI.detectMainBranch).not.toHaveBeenCalled();
		expect(updateEnvConfig).not.toHaveBeenCalled();
		cleanup();

		(globalThis.electronAPI.getGitBranchesWithInfo as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ success: false, error: "not a git repository" })
			.mockRejectedValueOnce(new Error("IPC"))
			.mockResolvedValueOnce({ success: false });
		(globalThis.electronAPI.detectMainBranch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false });
		renderGitHub({ defaultBranch: "" });
		expect(await screen.findByText("not a git repository")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("IPC")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Failed to load branches")).toBeInTheDocument();
		cleanup();

		// Without a project folder, no branch to choose.
		renderGitHub({}, { projectPath: undefined });
		expect(screen.queryByText("Default branch")).toBeNull();
	});
});
