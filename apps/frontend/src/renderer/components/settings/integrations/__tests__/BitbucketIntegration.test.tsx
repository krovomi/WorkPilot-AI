/**
 * The Bitbucket settings of a project: the switch shows the fields, each
 * field updates its key, an empty repository is filled from a bitbucket.org
 * remote (and never from another host), and the connection test reports the
 * repository or why it failed.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { ProjectEnvConfig } from "../../../../../shared/types";
import { BitbucketIntegration } from "../BitbucketIntegration";

let api: { detectRepoProvider: ReturnType<typeof vi.fn>; bitbucket: { checkConnection: ReturnType<typeof vi.fn> } };
const config = (extra: Partial<ProjectEnvConfig> = {}) => ({ bitbucketEnabled: true, ...extra }) as ProjectEnvConfig;

function renderIt(envConfig: ProjectEnvConfig | null, projectPath: string | undefined = "/repo") {
	const updateEnvConfig = vi.fn();
	const view = render(
		<BitbucketIntegration
			projectId="p1"
			projectPath={projectPath}
			envConfig={envConfig}
			updateEnvConfig={updateEnvConfig}
		/>,
	);
	return { updateEnvConfig, ...view };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	api = {
		detectRepoProvider: vi.fn().mockResolvedValue({
			success: true,
			data: { provider: "bitbucket", remoteUrl: "git@bitbucket.org:acme/web.git" },
		}),
		bitbucket: {
			checkConnection: vi.fn().mockResolvedValue({ success: true, data: { connected: true, fullName: "acme/web" } }),
		},
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("BitbucketIntegration", () => {
	it("renders nothing without a config, and only the switch while off", () => {
		const { container, rerender, updateEnvConfig } = renderIt(null);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<BitbucketIntegration projectId="p1" envConfig={config({ bitbucketEnabled: false })} updateEnvConfig={updateEnvConfig} />,
		);
		expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("switch", { name: "Enable Bitbucket" }));
		expect(updateEnvConfig).toHaveBeenCalledWith({ bitbucketEnabled: true });
		expect(api.detectRepoProvider).not.toHaveBeenCalled();
	});

	it("updates each field", () => {
		const { updateEnvConfig } = renderIt(
			config({ bitbucketWorkspace: "acme", bitbucketRepo: "web", bitbucketToken: "********" }),
		);
		fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "dev" } });
		fireEvent.change(screen.getByLabelText("Token"), { target: { value: "bb-test-0000" } });
		fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "team" } });
		fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "api" } });
		fireEvent.click(screen.getByRole("switch", { name: "Load issues when the project opens" }));
		expect(updateEnvConfig.mock.calls).toEqual([
			[{ bitbucketUsername: "dev" }],
			[{ bitbucketToken: "bb-test-0000" }],
			[{ bitbucketWorkspace: "team" }],
			[{ bitbucketRepo: "api" }],
			[{ bitbucketAutoSync: true }],
		]);
		expect(api.detectRepoProvider).not.toHaveBeenCalled();
	});

	it("fills an empty repository from the bitbucket.org remote", async () => {
		const { updateEnvConfig } = renderIt(config());
		await waitFor(() =>
			expect(updateEnvConfig).toHaveBeenCalledWith({ bitbucketWorkspace: "acme", bitbucketRepo: "web" }),
		);
		expect(api.detectRepoProvider).toHaveBeenCalledWith("/repo");
	});

	it("leaves the repository empty for another host, a failed detection or no project path", async () => {
		api.detectRepoProvider.mockResolvedValueOnce({
			success: true,
			data: { provider: "unknown", remoteUrl: "https://bitbucket.org.evil.example/acme/web" },
		});
		const first = renderIt(config());
		await waitFor(() => expect(api.detectRepoProvider).toHaveBeenCalledTimes(1));
		first.unmount();

		api.detectRepoProvider.mockResolvedValueOnce({ success: false });
		const second = renderIt(config());
		await waitFor(() => expect(api.detectRepoProvider).toHaveBeenCalledTimes(2));
		second.unmount();

		api.detectRepoProvider.mockRejectedValueOnce(new Error("x"));
		const third = renderIt(config());
		await waitFor(() => expect(api.detectRepoProvider).toHaveBeenCalledTimes(3));
		third.unmount();

		const fourth = renderIt(config(), "");
		await Promise.resolve();
		expect(api.detectRepoProvider).toHaveBeenCalledTimes(3);
		for (const view of [first, second, third, fourth]) expect(view.updateEnvConfig).not.toHaveBeenCalled();
	});

	it("does not fill the repository once the view is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.detectRepoProvider.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const { updateEnvConfig, unmount } = renderIt(config());
		unmount();
		answer({ success: true, data: { provider: "bitbucket", remoteUrl: "https://bitbucket.org/acme/web" } });
		await Promise.resolve();
		expect(updateEnvConfig).not.toHaveBeenCalled();
	});

	it("tests the saved connection and says the repository or why it failed", async () => {
		renderIt(config({ bitbucketWorkspace: "acme", bitbucketRepo: "web" }));
		expect(screen.getByText("Not tested yet")).toBeInTheDocument();
		const test = screen.getByRole("button", { name: "Test" });

		fireEvent.click(test);
		expect(await screen.findByText("Connected to acme/web")).toBeInTheDocument();
		expect(api.bitbucket.checkConnection).toHaveBeenCalledWith("p1");

		api.bitbucket.checkConnection.mockResolvedValueOnce({ success: true, data: { connected: false } });
		fireEvent.click(test);
		expect(await screen.findByText("Not connected")).toBeInTheDocument();

		api.bitbucket.checkConnection.mockResolvedValueOnce({ success: true, data: { connected: true } });
		fireEvent.click(test);
		expect(await screen.findByText("Connected to")).toBeInTheDocument();

		api.bitbucket.checkConnection.mockResolvedValueOnce({ success: false, error: "Bitbucket API error 401" });
		fireEvent.click(test);
		expect(await screen.findByText("Bitbucket API error 401")).toBeInTheDocument();

		let answer: (value: unknown) => void = () => undefined;
		api.bitbucket.checkConnection.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		fireEvent.click(test);
		expect(await screen.findByText("Checking…")).toBeInTheDocument();
		expect(test).toBeDisabled();
		answer(undefined);
		expect(await screen.findByText("Could not check the Bitbucket connection.")).toBeInTheDocument();

		api.bitbucket.checkConnection.mockRejectedValueOnce(new Error("x"));
		fireEvent.click(test);
		await waitFor(() => expect(test).not.toBeDisabled());
		expect(screen.getByText("Could not check the Bitbucket connection.")).toBeInTheDocument();
	});
});
