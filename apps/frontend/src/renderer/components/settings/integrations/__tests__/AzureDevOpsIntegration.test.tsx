/**
 * AzureDevOpsIntegration — a project's Azure DevOps settings: the organization
 * address (which points the token link at that organization), the token, the
 * repository (listed once, and detected from the git remote when none is set),
 * the connection and the import of work items.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../../__tests__/helpers/renderer-api";
import type { AzureDevOpsSyncStatus, ProjectEnvConfig } from "../../../../../shared/types";
import { AzureDevOpsIntegration } from "../AzureDevOpsIntegration";

const REPOS = [
	{ id: "1", name: "api" },
	{ id: "2", name: "site" },
];

let api: RendererApi;

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
	api = installRendererApi({
		listAzureDevOpsRepositories: vi.fn(async () => ({ success: true, data: REPOS })),
		detectAzureDevOpsRepository: vi.fn(async () => ({ success: true, data: { repository: "site" } })),
	});
});

afterEach(() => {
	cleanup();
	api.restore();
	vi.clearAllMocks();
});

const listRepos = () => globalThis.electronAPI.listAzureDevOpsRepositories as unknown as ReturnType<typeof vi.fn>;
const detectRepo = () => globalThis.electronAPI.detectAzureDevOpsRepository as unknown as ReturnType<typeof vi.fn>;

function renderAzure(
	env: Partial<ProjectEnvConfig> | null = {},
	options: { status?: AzureDevOpsSyncStatus | null; checking?: boolean; showPat?: boolean } = {},
) {
	const updateEnvConfig = vi.fn();
	const setShowAzureDevOpsPat = vi.fn();
	const onOpenAzureDevOpsImport = vi.fn();
	const props = {
		envConfig: env === null ? null : ({ azureDevOpsEnabled: true, ...env } as ProjectEnvConfig),
		updateEnvConfig,
		showAzureDevOpsPat: options.showPat ?? false,
		setShowAzureDevOpsPat,
		azureDevOpsConnectionStatus: options.status ?? null,
		isCheckingAzureDevOps: options.checking ?? false,
		onOpenAzureDevOpsImport,
		projectId: "p1",
	};
	const view = render(<AzureDevOpsIntegration {...props} />);
	return { updateEnvConfig, setShowAzureDevOpsPat, onOpenAzureDevOpsImport, props, ...view };
}

describe("AzureDevOpsIntegration", () => {
	it("shows nothing without the project's configuration, and only the switch while the sync is off", async () => {
		const { container } = renderAzure(null);
		expect(container).toBeEmptyDOMElement();
		cleanup();
		const { updateEnvConfig } = renderAzure({ azureDevOpsEnabled: false });
		await userEvent.click(screen.getByRole("switch", { name: "Enable Azure DevOps Sync" }));
		expect(updateEnvConfig).toHaveBeenCalledWith({ azureDevOpsEnabled: true });
		expect(screen.queryByLabelText("Organization URL")).toBeNull();
		expect(listRepos()).not.toHaveBeenCalled();
	});

	it("points the token link at the organization typed, and takes the token", async () => {
		const { updateEnvConfig, setShowAzureDevOpsPat, rerender, props } = renderAzure({ azureDevOpsRepository: "api" });
		const link = () => screen.getByRole("link", { name: "Azure DevOps User Settings" });
		expect(link()).toHaveAttribute("href", "https://dev.azure.com/_usersettings/tokens");

		await userEvent.type(screen.getByLabelText("Organization URL"), "h");
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ azureDevOpsOrgUrl: "h" });
		const withUrl = (url: string) => (
			<AzureDevOpsIntegration {...props} envConfig={{ ...props.envConfig, azureDevOpsOrgUrl: url } as ProjectEnvConfig} />
		);
		rerender(withUrl("https://dev.azure.com/contoso/"));
		expect(link()).toHaveAttribute("href", "https://dev.azure.com/contoso/_usersSettings/tokens");
		rerender(withUrl("https://fabrikam.visualstudio.com/"));
		expect(link()).toHaveAttribute("href", "https://dev.azure.com/fabrikam/_usersSettings/tokens");
		// Still being typed, or another host: the generic page.
		rerender(withUrl("https://dev.az"));
		expect(link()).toHaveAttribute("href", "https://dev.azure.com/_usersettings/tokens");
		rerender(withUrl("not a url"));
		expect(link()).toHaveAttribute("href", "https://dev.azure.com/_usersettings/tokens");

		await userEvent.type(screen.getByLabelText("Personal Access Token (PAT)"), "x");
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ azureDevOpsPat: "x" });
		expect(screen.getByLabelText("Personal Access Token (PAT)")).toHaveAttribute("type", "password");
		await userEvent.click(screen.getByRole("button", { name: "Show the token" }));
		expect(setShowAzureDevOpsPat).toHaveBeenCalledWith(true);
		rerender(<AzureDevOpsIntegration {...props} showAzureDevOpsPat />);
		expect(screen.getByLabelText("Personal Access Token (PAT)")).toHaveAttribute("type", "text");
		expect(screen.getByRole("button", { name: "Hide the token" })).toBeInTheDocument();
	});

	it("lists the repositories once and saves the one picked", async () => {
		const { updateEnvConfig } = renderAzure({ azureDevOpsRepository: "api" });
		const trigger = await screen.findByRole("combobox", { name: "Repository" });
		expect(trigger).toHaveTextContent("api");
		await userEvent.click(trigger);
		await userEvent.click(await screen.findByRole("option", { name: "site" }));
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ azureDevOpsRepository: "site" });
		// Loading the list once, not on every render.
		expect(listRepos()).toHaveBeenCalledTimes(1);
		expect(listRepos()).toHaveBeenCalledWith("p1");
		expect(detectRepo()).not.toHaveBeenCalled();
	});

	it("keeps a saved repository that the list no longer has", async () => {
		renderAzure({ azureDevOpsRepository: "renamed" });
		expect(await screen.findByRole("combobox", { name: "Repository" })).toHaveTextContent("renamed");
	});

	it("detects the repository from the git remote once when none is set", async () => {
		const { updateEnvConfig, rerender, props } = renderAzure({});
		await waitFor(() => expect(updateEnvConfig).toHaveBeenCalledWith({ azureDevOpsRepository: "site" }));
		rerender(<AzureDevOpsIntegration {...props} />);
		rerender(<AzureDevOpsIntegration {...props} />);
		expect(detectRepo()).toHaveBeenCalledTimes(1);
		expect(detectRepo()).toHaveBeenCalledWith("p1");
		cleanup();

		// Nothing detected, or the detection fails: nothing is chosen.
		detectRepo().mockResolvedValueOnce({ success: true, data: {} }).mockRejectedValueOnce(new Error("no remote"));
		const first = renderAzure({});
		await waitFor(() => expect(detectRepo()).toHaveBeenCalledTimes(2));
		first.rerender(<AzureDevOpsIntegration {...first.props} projectId="p2" />);
		await waitFor(() => expect(detectRepo()).toHaveBeenCalledWith("p2"));
		await act(() => Promise.resolve());
		expect(first.updateEnvConfig).not.toHaveBeenCalled();
	});

	it("drops a detection that answers after the project changed", async () => {
		let answer: (value: unknown) => void = () => undefined;
		detectRepo().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		const { updateEnvConfig, rerender, props, unmount } = renderAzure({});
		rerender(<AzureDevOpsIntegration {...props} projectId="p2" />);
		await waitFor(() => expect(updateEnvConfig).toHaveBeenCalledWith({ azureDevOpsRepository: "site" }));
		updateEnvConfig.mockClear();
		await act(async () => answer({ success: true, data: { repository: "old" } }));
		expect(updateEnvConfig).not.toHaveBeenCalled();
		unmount();
	});

	it("says when the repositories cannot be read, and reads them again", async () => {
		listRepos()
			.mockResolvedValueOnce({ success: false, error: "TF400813: not authorized" })
			.mockRejectedValueOnce(new Error("IPC"))
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce("boom");
		renderAzure({ azureDevOpsRepository: "api" });
		expect(await screen.findByText("TF400813: not authorized")).toBeInTheDocument();
		const refresh = () => screen.getByRole("button", { name: "Refresh list" });
		await userEvent.click(refresh());
		expect(await screen.findByText("IPC")).toBeInTheDocument();
		await userEvent.click(refresh());
		expect(await screen.findByText("Error loading repositories")).toBeInTheDocument();
		await userEvent.click(refresh());
		await waitFor(() => expect(listRepos()).toHaveBeenCalledTimes(4));
		expect(await screen.findByText("Error loading repositories")).toBeInTheDocument();
		await userEvent.click(refresh());
		expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();
	});

	it("shows the connection and opens the import once connected", async () => {
		const filled = { azureDevOpsPat: "••••", azureDevOpsOrgUrl: "https://dev.azure.com/contoso", azureDevOpsRepository: "api" };
		const { rerender, props, onOpenAzureDevOpsImport } = renderAzure(filled, { checking: true });
		expect(screen.getByText("Checking...")).toBeInTheDocument();
		const status = (s: AzureDevOpsSyncStatus) => (
			<AzureDevOpsIntegration {...props} isCheckingAzureDevOps={false} azureDevOpsConnectionStatus={s} />
		);
		rerender(<AzureDevOpsIntegration {...props} isCheckingAzureDevOps={false} />);
		expect(screen.getByText("Not connected")).toBeInTheDocument();
		rerender(status({ connected: false, error: "TF401444: sign in" } as AzureDevOpsSyncStatus));
		expect(screen.getByText("TF401444: sign in")).toBeInTheDocument();
		expect(screen.queryByText("Import Work Items")).toBeNull();
		rerender(status({ connected: true } as AzureDevOpsSyncStatus));
		expect(screen.getByText("Connected")).toBeInTheDocument();
		rerender(status({ connected: true, projectName: "Contoso", workItemCount: 12 } as AzureDevOpsSyncStatus));
		expect(screen.getByText("Connected to project Contoso")).toBeInTheDocument();
		expect(screen.getByText("12+ work items available to import")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Select Work Items to Import" }));
		expect(onOpenAzureDevOpsImport).toHaveBeenCalled();
	});

	it("turns the auto sync on and explains it", async () => {
		const { updateEnvConfig, rerender, props } = renderAzure({ azureDevOpsRepository: "api" });
		expect(screen.queryByText("Note:")).toBeNull();
		await userEvent.click(screen.getByRole("switch", { name: "Auto Sync" }));
		expect(updateEnvConfig).toHaveBeenLastCalledWith({ azureDevOpsAutoSync: true });
		rerender(<AzureDevOpsIntegration {...props} envConfig={{ ...props.envConfig, azureDevOpsAutoSync: true } as ProjectEnvConfig} />);
		expect(screen.getByText("Note:")).toBeInTheDocument();
	});

	it("uses a saved account instead of the organization and PAT fields", async () => {
		const { updateEnvConfig } = renderAzure({ azureDevOpsAccountId: "acct-1" });
		expect(screen.queryByLabelText("Organization URL")).toBeNull();
		expect(screen.queryByLabelText("Personal Access Token (PAT)")).toBeNull();
		expect(await screen.findByRole("option", { name: "Deleted account" })).toBeInTheDocument();
		await userEvent.selectOptions(screen.getByLabelText("Account"), "");
		expect(updateEnvConfig).toHaveBeenCalledWith({ azureDevOpsAccountId: "" });
	});
});
