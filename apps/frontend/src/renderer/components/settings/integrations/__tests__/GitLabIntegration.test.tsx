/**
 * A glab sign-in from the GitLab settings: once glab is signed in, the page
 * keeps the mask the main process answers for glab's token, with the OAuth
 * method, so saving the settings stores glab's token from the main process.
 * The instance is named by its host, as the main process reads it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../../../../../shared/constants";
import type { ProjectEnvConfig } from "../../../../../shared/types";
import { GitLabIntegration } from "../GitLabIntegration";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const api = {
	checkGitLabCli: vi.fn(async () => ({ success: true, data: { installed: true, version: "1.50" } })),
	startGitLabAuth: vi.fn(async (_host?: string) => ({ success: true })),
	checkGitLabAuth: vi.fn(async (_host?: string) => ({
		success: true,
		data: { authenticated: true },
	})),
	getGitLabToken: vi.fn(async (_host?: string) => ({
		success: true,
		data: { token: MASKED_SECRET },
	})),
	getGitLabUser: vi.fn(async (_host?: string) => ({ success: true, data: { username: "ada" } })),
	listGitLabUserProjects: vi.fn(async () => ({ success: true, data: { projects: [] } })),
	getGitBranches: vi.fn(async () => ({ success: true, data: [] })),
	listForgeAccounts: vi.fn(async () => ({ success: true, data: [] })),
};

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	Object.defineProperty(globalThis, "electronAPI", {
		value: api,
		writable: true,
		configurable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("the glab sign-in of the GitLab settings", () => {
	it("keeps the token's mask with the OAuth method, for the instance's host", async () => {
		const updateEnvConfig = vi.fn();
		render(
			<GitLabIntegration
				envConfig={
					{
						gitlabEnabled: true,
						gitlabInstanceUrl: "https://gitlab.acme.dev/",
					} as ProjectEnvConfig
				}
				updateEnvConfig={updateEnvConfig}
				showGitLabToken={false}
				setShowGitLabToken={vi.fn()}
				gitLabConnectionStatus={null}
				isCheckingGitLab={false}
			/>,
		);
		const useOAuth = await screen.findByText("settings.useOAuth");
		await waitFor(() => expect(useOAuth.closest("button")).not.toBeDisabled());

		fireEvent.click(useOAuth);
		await vi.advanceTimersByTimeAsync(3000);

		await waitFor(() =>
			expect(updateEnvConfig).toHaveBeenCalledWith({
				gitlabToken: MASKED_SECRET,
				gitlabAuthMethod: "oauth",
			}),
		);
		expect(api.startGitLabAuth).toHaveBeenCalledWith("gitlab.acme.dev");
		expect(api.getGitLabToken).toHaveBeenCalledWith("gitlab.acme.dev");
	});

	it("uses a saved account instead of the instance and token fields, keeping the project", async () => {
		const updateEnvConfig = vi.fn();
		render(
			<GitLabIntegration
				envConfig={
					{ gitlabEnabled: true, gitlabAccountId: "acct-1", gitlabProject: "acme/app" } as ProjectEnvConfig
				}
				updateEnvConfig={updateEnvConfig}
				showGitLabToken={false}
				setShowGitLabToken={vi.fn()}
				gitLabConnectionStatus={null}
				isCheckingGitLab={false}
			/>,
		);
		expect(screen.queryByText("settings.useOAuth")).toBeNull();
		expect(screen.getByDisplayValue("acme/app")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("forgeAccounts.picker.label"), { target: { value: "" } });
		expect(updateEnvConfig).toHaveBeenCalledWith({ gitlabAccountId: "" });
	});
});
