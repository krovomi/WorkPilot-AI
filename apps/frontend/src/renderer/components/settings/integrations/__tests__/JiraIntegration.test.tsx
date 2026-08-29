/**
 * "Test Connection" used to report success without testing anything.
 *
 * The component guarded on `electronAPI.jiraTestConnection` — a name declared
 * only in `types/window.d.ts` and implemented by no preload module. The real
 * bridge is `testJiraConnection` (`preload/api/modules/jira-api.ts`). The guard
 * therefore never matched, and the fallback branch ran instead:
 *
 *     } else if (jiraInstanceUrl && jiraEmail && jiraApiToken) {
 *         setConnectionStatus({ connected: true, ... });
 *
 * Three filled fields were enough to be told the credentials worked. Announcing
 * a connection nobody tested is worse than announcing a failure — the user
 * walks away with unverified credentials and finds out later.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvConfig } from "../../../../../shared/types";
import { JiraIntegration } from "../JiraIntegration";

vi.mock("react-i18next", () => ({
	// `Input` reads `i18n.language` for its `lang` attribute, so the mock has
	// to carry more than `t`.
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" },
	}),
}));

const envConfig = {
	jiraEnabled: true,
	jiraInstanceUrl: "https://example.atlassian.net",
	jiraEmail: "someone@example.com",
	jiraApiToken: "a-token",
	jiraProjectKey: "WP",
} as ProjectEnvConfig;

function renderJira() {
	return render(
		<JiraIntegration
			envConfig={envConfig}
			updateEnvConfig={vi.fn()}
			showJiraToken={false}
			setShowJiraToken={vi.fn()}
		/>,
	);
}

function clickTestConnection() {
	// The label goes through the identity `t`, so it is the raw key here.
	fireEvent.click(screen.getByText("jira.testConnection"));
}

function setElectronAPI(value: unknown): void {
	Object.defineProperty(globalThis, "electronAPI", {
		value,
		writable: true,
		configurable: true,
	});
}

describe("Jira connection test", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls the bridge that actually exists", async () => {
		const testJiraConnection = vi
			.fn()
			.mockResolvedValue({ success: true, data: { connected: true } });
		setElectronAPI({ testJiraConnection });

		renderJira();
		clickTestConnection();

		await waitFor(() => expect(testJiraConnection).toHaveBeenCalledTimes(1));
		expect(testJiraConnection).toHaveBeenCalledWith({
			instanceUrl: "https://example.atlassian.net",
			email: "someone@example.com",
			apiToken: "a-token",
		});
	});

	it("reports failure — never success — when no bridge answers", async () => {
		setElectronAPI({});

		renderJira();
		clickTestConnection();

		// The whole point: three filled fields must not be mistaken for a
		// working Jira instance.
		await waitFor(() =>
			expect(screen.getByText("jira.bridgeUnavailable")).toBeTruthy(),
		);
		expect(screen.queryByText("jira.connected")).toBeNull();
	});

	it("surfaces the error the bridge returns", async () => {
		setElectronAPI({
			testJiraConnection: vi
				.fn()
				.mockResolvedValue({ success: false, error: "401 Unauthorized" }),
		});

		renderJira();
		clickTestConnection();

		await waitFor(() =>
			expect(screen.getByText(/401 Unauthorized/)).toBeTruthy(),
		);
	});
});
