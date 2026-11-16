/**
 * A server project's menu lists its own forge's views: GitLab's issues and
 * merge requests for a project on GitLab, GitHub's for one on GitHub. The
 * menu's filter used to ignore the forge, so a server project on GitLab lost
 * the whole "Git & Integrations" space (its entries were filtered out with
 * GitHub's).
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en", changeLanguage: vi.fn() },
	}),
	Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

// The dialogs, banners and status chips the menu hosts are not under test.
vi.mock("../AddProjectModal", () => ({ AddProjectModal: () => null }));
vi.mock("../AzureDevOpsSetupModal", () => ({ AzureDevOpsSetupModal: () => null }));
vi.mock("../app-emulator/AppEmulatorDialog", () => ({ AppEmulatorDialog: () => null }));
vi.mock("../arena/ArenaDialog", () => ({ ArenaDialog: () => null }));
vi.mock("../code-playground/CodePlaygroundDialog", () => ({ CodePlaygroundDialog: () => null }));
vi.mock("../conflict-predictor/ConflictPredictorDialog", () => ({ ConflictPredictorDialog: () => null }));
vi.mock("../context-aware-snippets/ContextAwareSnippetsDialog", () => ({ ContextAwareSnippetsDialog: () => null }));
vi.mock("../dependency-sentinel/DependencySentinelDialog", () => ({ DependencySentinelDialog: () => null }));
vi.mock("../GitHubSetupModal", () => ({ GitHubSetupModal: () => null }));
vi.mock("../GitSetupModal", () => ({ GitSetupModal: () => null }));
vi.mock("../learning-loop/LearningLoopDialog", () => ({ LearningLoopDialog: () => null }));
vi.mock("../natural-language-git/NaturalLanguageGitDialog", () => ({ NaturalLanguageGitDialog: () => null }));
vi.mock("../prompt-optimizer/PromptOptimizerDialog", () => ({ PromptOptimizerDialog: () => null }));
vi.mock("../RateLimitIndicator", () => ({ RateLimitIndicator: () => null }));
vi.mock("../smart-estimation/SmartEstimationDialog", () => ({ SmartEstimationDialog: () => null }));
vi.mock("../test-generation/TestGenerationDialog", () => ({ TestGenerationDialog: () => null }));
vi.mock("../SecureStorageBanner", () => ({ SecureStorageBanner: () => null }));
vi.mock("../UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("../sidebar/CliToolsChip", () => ({ CliToolsChip: () => null }));
vi.mock("../voice-assistant/VoiceAssistant", () => ({ VoiceAssistant: () => null }));

import type { Project } from "@shared/types";
import { useProjectStore } from "@/stores/project-store";
import { Sidebar } from "../Sidebar";

function serverProject(forge: "github" | "gitlab"): Project {
	return {
		id: `p-${forge}`,
		name: `Team ${forge}`,
		path: `/srv/${forge}`,
		autoBuildPath: "",
		settings: {},
		createdAt: new Date("2026-11-01T09:00:00Z"),
		updatedAt: new Date("2026-11-01T09:00:00Z"),
		remote: {
			repoUrl: `https://${forge}.example/team/site.git`,
			defaultBranch: "main",
			role: "member",
			forge,
		},
	} as unknown as Project;
}

beforeEach(() => {
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
		{},
		{
			get: () =>
				new Proxy(() => Promise.resolve({ success: false }), {
					get: () => () => Promise.resolve({ success: false }),
				}),
		},
	);
});

afterEach(() => {
	cleanup();
});

describe("Sidebar on a server project", () => {
	it.each([
		["gitlab", "navigation:items.gitlabIssues", "navigation:items.githubIssues"],
		["github", "navigation:items.githubIssues", "navigation:items.gitlabIssues"],
	] as const)("on %s, lists that forge's views only", (forge, shown, hidden) => {
		const project = serverProject(forge);
		useProjectStore.setState({
			projects: [project],
			selectedProjectId: project.id,
			openProjectIds: [project.id],
			activeProjectId: project.id,
		});

		render(<Sidebar onSettingsClick={vi.fn()} onNewTaskClick={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: "navigation:groups.gitIntegrations" }));
		expect(screen.getAllByText(shown).length).toBeGreaterThan(0);
		expect(screen.queryAllByText(hidden)).toHaveLength(0);
	});
});
