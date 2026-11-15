/**
 * `registerGithubHandlers` wires every GitHub module, the review feedback
 * channels of #361 included (each module's handlers are tested on their own).
 */
import { describe, expect, it, vi } from "vitest";

const { calls, register } = vi.hoisted(() => {
	const calls: string[] = [];
	const register = (name: string) => () => {
		calls.push(name);
	};
	return { calls, register };
});

vi.mock("../autofix-handlers", () => ({ registerAutoFixHandlers: register("autofix") }));
vi.mock("../import-handlers", () => ({ registerImportHandlers: register("import") }));
vi.mock("../investigation-handlers", () => ({
	registerInvestigationHandlers: register("investigation"),
}));
vi.mock("../issue-handlers", () => ({ registerIssueHandlers: register("issue") }));
vi.mock("../oauth-handlers", () => ({ registerGithubOAuthHandlers: register("oauth") }));
vi.mock("../pr-handlers", () => ({ registerPRHandlers: register("pr") }));
vi.mock("../release-handlers", () => ({ registerReleaseHandlers: register("release") }));
vi.mock("../repository-handlers", () => ({
	registerRepositoryHandlers: register("repository"),
}));
vi.mock("../review-feedback-handlers", () => ({
	registerReviewFeedbackHandlers: register("review-feedback"),
}));
vi.mock("../utils", () => ({ getGitHubConfig: vi.fn(), githubFetch: vi.fn() }));

import { registerGithubHandlers } from "../index";

describe("registerGithubHandlers", () => {
	it("registers the review feedback channels with the PR ones", () => {
		registerGithubHandlers({} as never, () => null);
		expect(calls).toContain("pr");
		expect(calls).toContain("review-feedback");
		expect(calls).toHaveLength(9);
	});
});
