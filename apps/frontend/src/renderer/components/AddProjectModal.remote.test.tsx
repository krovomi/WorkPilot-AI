/**
 * @vitest-environment jsdom
 */
/**
 * Creating a project with a remote: which providers are offered and picked,
 * the remote dialogs, the summary, what is written to the project, and every
 * way creating can fail. The remote dialogs are replaced by buttons that save
 * a config, since they have their own tests of their forms.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { addProject, toast } = vi.hoisted(() => ({ addProject: vi.fn(), toast: vi.fn() }));

vi.mock("@/stores/project-store", () => ({ addProject }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("./GitHubRemoteConfigModal", () => ({
	GitHubRemoteConfigModal: ({ onSave }: { onSave: (c: { repo: string; token: string }) => void }) => (
		<button type="button" onClick={() => onSave({ repo: "octo/app", token: "ghp_x" })}>
			save-github
		</button>
	),
}));
vi.mock("./AzureDevOpsRemoteConfigModal", () => ({
	AzureDevOpsRemoteConfigModal: ({
		onSave,
	}: {
		onSave: (c: { orgUrl: string; pat: string }) => void;
	}) => (
		<button type="button" onClick={() => onSave({ orgUrl: "https://dev.azure.com/acme", pat: "pat" })}>
			save-azure
		</button>
	),
}));
vi.mock("./server-projects/ServerProjectDialog", () => ({
	ServerProjectDialog: ({ onChooseLocal }: { onChooseLocal: () => void }) => (
		<button type="button" onClick={onChooseLocal}>
			use-local-folder
		</button>
	),
}));

import { useServerSessionStore } from "@/stores/server-session-store";
import { AddProjectModal } from "./AddProjectModal";

const api = {
	selectDirectory: vi.fn(),
	createProjectFolder: vi.fn(),
	checkGitStatus: vi.fn(),
	updateProjectEnv: vi.fn(),
	readFile: vi.fn(),
	detectRepoProvider: vi.fn(),
	inspectProjectLocation: vi.fn(),
};

const PROJECT = { id: "p1", path: "/code/my-app", name: "My App" };

beforeEach(() => {
	vi.resetAllMocks();
	useServerSessionStore.setState({ mode: "local" } as never);
	api.checkGitStatus.mockResolvedValue({ success: false });
	api.readFile.mockResolvedValue({ success: false });
	api.detectRepoProvider.mockResolvedValue({ success: true, data: { provider: "unknown" } });
	api.inspectProjectLocation.mockResolvedValue({
		success: true,
		data: {
			targetExists: false,
			targetHasEntries: false,
			locationIsProject: false,
			insideRepository: null,
			markers: [],
		},
	});
	api.createProjectFolder.mockResolvedValue({
		success: true,
		data: { path: "/code/my-app", name: "my-app" },
	});
	api.updateProjectEnv.mockResolvedValue({ success: true });
	addProject.mockResolvedValue({ project: PROJECT });
	Object.assign(globalThis.electronAPI, api);
});

function renderModal() {
	const onOpenChange = vi.fn();
	const onProjectAdded = vi.fn();
	const view = render(
		<AddProjectModal open onOpenChange={onOpenChange} onProjectAdded={onProjectAdded} />,
	);
	return { ...view, onOpenChange, onProjectAdded };
}

function fill(name: string, location: string) {
	fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: name } });
	fireEvent.change(screen.getByLabelText("Location"), { target: { value: location } });
}

function next() {
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

function provider(name: RegExp) {
	return screen.getByRole("button", { name });
}

/** A target that is already a git repository whose config names this remote. */
function existingRepository(url: string | null) {
	api.checkGitStatus.mockResolvedValue({
		success: true,
		data: { isGitRepo: true, hasCommits: true, currentBranch: "main" },
	});
	api.readFile.mockResolvedValue(
		url ? { success: true, data: `[remote "origin"]\n\turl = ${url}\n` } : { success: false },
	);
}

describe("AddProjectModal with a remote", () => {
	it("keeps Next off until both the name and the location are given", () => {
		renderModal();
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "My App" } });
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	});

	it("creates a project with GitHub and writes the remote into its settings", async () => {
		const { onOpenChange, onProjectAdded } = renderModal();
		fill("My App", "/code");
		expect(screen.getByText("/code/my-app")).toBeInTheDocument();
		fireEvent.click(provider(/GitHub Repository/));
		expect(provider(/GitHub Repository/)).toHaveAttribute("aria-pressed", "true");
		next();
		fireEvent.click(await screen.findByRole("button", { name: "save-github", hidden: true }));
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
		expect(screen.getByText("octo/app")).toBeInTheDocument();
		expect(screen.getByText("Enabled")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(api.createProjectFolder).toHaveBeenCalledWith("/code", "My App", true);
		expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", {
			githubEnabled: true,
			githubToken: "ghp_x",
			githubRepo: "octo/app",
		});
		expect(onProjectAdded).toHaveBeenCalledWith(PROJECT, false);
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Project Created" }));
	});

	it("goes straight to the summary after the remote, even when the target folder already exists", async () => {
		// An existing folder without commits used to open a git dialog here, and
		// initialising git in it closed the wizard without creating the project.
		api.checkGitStatus.mockResolvedValue({
			success: true,
			data: { isGitRepo: false, hasCommits: false, currentBranch: null },
		});
		const { onOpenChange } = renderModal();
		fill("My App", "/code");
		fireEvent.click(provider(/Azure DevOps/));
		next();
		fireEvent.click(await screen.findByRole("button", { name: "save-azure", hidden: true }));
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.getByText("https://dev.azure.com/acme")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
		await waitFor(() =>
			expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", {
				azureDevOpsEnabled: true,
				azureDevOpsOrgUrl: "https://dev.azure.com/acme",
				azureDevOpsPat: "pat",
			}),
		);
	});

	it("enables Jira without a remote dialog, and creates without git when unticked", async () => {
		renderModal();
		fill("My App", "/code");
		fireEvent.click(screen.getByLabelText("Initialize local git"));
		fireEvent.click(provider(/Jira/));
		next();
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
		expect(screen.getByText("Jira")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
		await waitFor(() =>
			expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", { jiraEnabled: true }),
		);
		expect(api.createProjectFolder).toHaveBeenCalledWith("/code", "My App", false);
	});

	it("creates with no remote, then goes back and forth through the summary", async () => {
		renderModal();
		fill("My App", "/code");
		next();
		expect(await screen.findByText("No remote configured")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByLabelText("Project Name")).toHaveValue("My App");
		fireEvent.click(provider(/Skip for now/));
		next();
		fireEvent.click(await screen.findByRole("button", { name: "Create Project" }));
		await waitFor(() => expect(addProject).toHaveBeenCalledWith("/code/my-app"));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});

	it("goes to the summary when the name gives no folder to look at", async () => {
		renderModal();
		fill("???", "/code");
		next();
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
		expect(screen.getAllByText("/code").length).toBeGreaterThan(0);
		expect(api.checkGitStatus).not.toHaveBeenCalled();
	});

	it("refuses a repository URL as the location", async () => {
		renderModal();
		fill("My App", "https://github.com/octo/app");
		next();
		fireEvent.click(await screen.findByRole("button", { name: "Create Project" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The location must be a local path",
		);
		expect(api.createProjectFolder).not.toHaveBeenCalled();
	});

	it("says why the folder was not created, with a translated fallback", async () => {
		api.createProjectFolder
			.mockResolvedValueOnce({ success: false, error: "EEXIST" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("disk full"))
			.mockRejectedValueOnce("raw");
		renderModal();
		fill("My App", "/code");
		next();
		const create = await screen.findByRole("button", { name: "Create Project" });
		for (const message of ["EEXIST", "Failed to create project", "disk full", "Failed to create project"]) {
			fireEvent.click(create);
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
		}
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Creation Error", variant: "destructive" }),
		);
	});

	it("warns about the git root, and adds nothing to the settings without a project", async () => {
		addProject.mockResolvedValueOnce({ project: null, warning: "inside another repo" });
		const { onProjectAdded, onOpenChange } = renderModal();
		fill("My App", "/code");
		fireEvent.click(provider(/GitHub Repository/));
		next();
		fireEvent.click(await screen.findByRole("button", { name: "save-github", hidden: true }));
		fireEvent.click(await screen.findByRole("button", { name: "Create Project" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Possible misconfiguration", description: "inside another repo" }),
		);
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(onProjectAdded).not.toHaveBeenCalled();
	});

	it("fills the location from Browse and the name from a pasted URL or path", async () => {
		api.selectDirectory.mockResolvedValueOnce("/picked").mockResolvedValueOnce(null);
		renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Browse" }));
		await waitFor(() => expect(screen.getByLabelText("Location")).toHaveValue("/picked"));
		fireEvent.click(screen.getByRole("button", { name: "Browse" }));
		await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledTimes(2));
		expect(screen.getByLabelText("Location")).toHaveValue("/picked");

		const location = screen.getByLabelText("Location");
		const paste = (text: string) =>
			fireEvent.paste(location, { clipboardData: { getData: () => text } });
		for (const [text, name] of [
			["https://dev.azure.com/acme/web/_git/storefront", "storefront"],
			["https://github.com/octo/hello-world", "hello-world"],
			["https://github.com/octo/cloned.git", "cloned"],
			["https://gitlab.com/group/lab-app", "lab-app"],
			["https://bitbucket.org/team/bucket-app", "bucket-app"],
			["C:\\Users\\dev\\win-app", "win-app"],
			["/home/dev/unix-app", "unix-app"],
		]) {
			fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "" } });
			paste(text);
			expect(screen.getByLabelText("Project Name")).toHaveValue(name);
		}
		// A typed name is never replaced, and text that names nothing is ignored.
		paste("https://github.com/octo/other");
		expect(screen.getByLabelText("Project Name")).toHaveValue("unix-app");
		fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "" } });
		paste("plain words");
		paste("/trailing/");
		expect(screen.getByLabelText("Project Name")).toHaveValue("");
	});
});

describe("AddProjectModal detecting the remote of an existing repository", () => {
	it.each([
		["https://github.com/octo/app.git", /GitHub Repository/, /Azure DevOps/],
		["git@github.com:octo/app.git", /GitHub Repository/, /Azure DevOps/],
		["https://acme@dev.azure.com/acme/web/_git/app", /Azure DevOps/, /GitHub Repository/],
		["https://acme.visualstudio.com/web/_git/app", /Azure DevOps/, /GitHub Repository/],
	])("reads %s from .git/config and offers only that provider", async (url, shown, hidden) => {
		existingRepository(url);
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(provider(shown)).toHaveAttribute("aria-pressed", "true"));
		expect(screen.queryByRole("button", { name: hidden })).toBeNull();
		expect(provider(/Jira/)).toBeInTheDocument();
	});

	it("falls back to git when the config names no known host", async () => {
		existingRepository("https://example.org/app.git");
		api.detectRepoProvider.mockResolvedValue({ success: true, data: { provider: "azure_devops" } });
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(provider(/Azure DevOps/)).toHaveAttribute("aria-pressed", "true"));
	});

	it("falls back to git when the config cannot be read, and opens that provider's dialog", async () => {
		existingRepository(null);
		api.readFile.mockRejectedValue(new Error("EACCES"));
		api.detectRepoProvider.mockResolvedValue({ success: true, data: { provider: "github" } });
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(provider(/GitHub Repository/)).toHaveAttribute("aria-pressed", "true"));
		next();
		expect(await screen.findByRole("button", { name: "save-github", hidden: true })).toBeInTheDocument();
	});

	it("leaves the choice open when git knows no provider either", async () => {
		existingRepository(null);
		api.detectRepoProvider.mockResolvedValue({ success: false });
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(api.detectRepoProvider).toHaveBeenCalled());
		expect(provider(/Skip for now/)).toHaveAttribute("aria-pressed", "true");
		expect(provider(/GitHub Repository/)).toBeInTheDocument();
		expect(provider(/Azure DevOps/)).toBeInTheDocument();
	});

	it.each([
		["https://dev.azure.com/acme/web/_git/app", "save-azure"],
		["https://github.com/octo/app.git", "save-github"],
	])("on Next with nothing chosen, opens the dialog of the provider found then (%s)", async (url, dialog) => {
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(api.checkGitStatus).toHaveBeenCalled());
		// The repository appears after the form was filled.
		existingRepository(url);
		next();
		expect(await screen.findByRole("button", { name: dialog, hidden: true })).toBeInTheDocument();
	});

	it("on Next, goes to the summary when the provider found then is unknown or the check fails", async () => {
		renderModal();
		fill("My App", "/code");
		await waitFor(() => expect(api.checkGitStatus).toHaveBeenCalled());
		existingRepository(null);
		api.detectRepoProvider.mockResolvedValue({ success: true, data: { provider: "unknown" } });
		next();
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		api.checkGitStatus.mockRejectedValue(new Error("git missing"));
		next();
		expect(await screen.findByText("Configuration Summary")).toBeInTheDocument();
	});
});

describe("AddProjectModal opening an existing folder", () => {
	it("explains a folder that could not be added, and warns about its git root", async () => {
		api.selectDirectory.mockResolvedValue("/code/existing");
		addProject
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("not a directory"))
			.mockRejectedValueOnce("raw")
			.mockResolvedValueOnce({ project: PROJECT, warning: "nested repository" });
		const { onProjectAdded } = renderModal();
		const open = screen.getByRole("button", { name: "Open existing project folder" });
		for (const message of ["Failed to create project", "not a directory", "Failed to create project"]) {
			fireEvent.click(open);
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
		}
		fireEvent.click(open);
		await waitFor(() => expect(onProjectAdded).toHaveBeenCalledWith(PROJECT, false));
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Possible misconfiguration", description: "nested repository" }),
		);
	});
});

describe("AddProjectModal in server mode", () => {
	it("offers the server's projects first, and this computer's folders on request", async () => {
		useServerSessionStore.setState({ mode: "server" } as never);
		renderModal();
		expect(screen.queryByLabelText("Project Name")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "use-local-folder", hidden: true }));
		expect(await screen.findByLabelText("Project Name")).toBeInTheDocument();
	});
});
