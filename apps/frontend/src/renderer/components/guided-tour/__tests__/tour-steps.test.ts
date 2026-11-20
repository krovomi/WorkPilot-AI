import type { ProjectEnvConfig } from "@shared/types/project";
import { afterEach, describe, expect, it } from "vitest";
import { useProjectEnvStore } from "../../../stores/project-env-store";
import { computeSetupCategories } from "../../setup-hub/useSetupStatus";
import { GUIDE_ANCHORS } from "../anchors";
import { buildTodoTour } from "../tour-steps";

/** Minimal env config; the tests only set the fields they read. */
const env = (overrides: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig =>
	({ ...overrides }) as ProjectEnvConfig;

/** All anchors present in the produced tour, in order. */
const anchorsOf = (status: ReturnType<typeof computeSetupCategories>) =>
	buildTodoTour(status).map((s) => s.anchor);

describe("buildTodoTour", () => {
	it("emits journeys only for items still in 'todo' state", () => {
		// GitHub configured (done) -> skipped; Jira not configured -> included.
		const status = computeSetupCategories(
			{ anthropic: true }, // providers done -> providers step skipped
			env({ githubEnabled: true, githubToken: "ghp_x" }),
		);
		const anchors = anchorsOf(status);

		// GitHub done -> none of its steps.
		expect(anchors).not.toContain(GUIDE_ANCHORS.github.enable);
		// Providers done -> no providers step.
		expect(anchors).not.toContain(GUIDE_ANCHORS.providers.configure);
		// Jira still todo -> its enable step is present.
		expect(anchors).toContain(GUIDE_ANCHORS.jira.enable);
	});

	it("orders the toggle step before the field steps within a journey", () => {
		const status = computeSetupCategories({}, env());
		const anchors = anchorsOf(status);
		const enableIdx = anchors.indexOf(GUIDE_ANCHORS.jira.enable);
		const tokenIdx = anchors.indexOf(GUIDE_ANCHORS.jira.token);
		expect(enableIdx).toBeGreaterThanOrEqual(0);
		expect(tokenIdx).toBeGreaterThan(enableIdx);
	});

	it("keeps AI providers before project integrations (category priority)", () => {
		const status = computeSetupCategories({}, env()); // nothing configured
		const anchors = anchorsOf(status);
		const providersIdx = anchors.indexOf(GUIDE_ANCHORS.providers.configure);
		const githubIdx = anchors.indexOf(GUIDE_ANCHORS.github.enable);
		expect(providersIdx).toBe(0);
		expect(githubIdx).toBeGreaterThan(providersIdx);
	});

	it("attaches the correct deep-link section to each step", () => {
		const status = computeSetupCategories({}, env());
		const steps = buildTodoTour(status);
		const jiraStep = steps.find((s) => s.anchor === GUIDE_ANCHORS.jira.token);
		expect(jiraStep?.section).toEqual({ kind: "project", section: "jira" });
		const providerStep = steps.find(
			(s) => s.anchor === GUIDE_ANCHORS.providers.configure,
		);
		expect(providerStep?.section).toEqual({ kind: "app", section: "accounts" });
	});

	it("produces an empty tour when everything is configured", () => {
		const status = computeSetupCategories(
			{ anthropic: true },
			env({
				githubEnabled: true,
				githubToken: "t",
				gitlabEnabled: true,
				gitlabToken: "t",
				azureDevOpsEnabled: true,
				azureDevOpsPat: "t",
				jiraEnabled: true,
				jiraApiToken: "t",
				linearEnabled: true,
				linearApiKey: "t",
				cicdProvider: "github",
				teamsNotificationsEnabled: true,
				teamsWebhookUrl: "https://hook",
			}),
		);
		expect(buildTodoTour(status)).toHaveLength(0);
	});

	it("marks toggle/field steps with a condition and optional steps without", () => {
		const status = computeSetupCategories({}, env());
		const steps = buildTodoTour(status);
		const enable = steps.find((s) => s.anchor === GUIDE_ANCHORS.jira.enable);
		const projectKey = steps.find(
			(s) => s.anchor === GUIDE_ANCHORS.jira.projectKey,
		);
		expect(typeof enable?.condition).toBe("function");
		expect(projectKey?.optional).toBe(true);
		expect(projectKey?.condition).toBeUndefined();
	});

	it("skips every project-scoped journey when there is no project yet, even though the items are 'todo'", () => {
		// Fresh install: no provider configured, no project, nothing done.
		const status = computeSetupCategories({}, null, false);
		const anchors = anchorsOf(status);

		expect(anchors).not.toContain(GUIDE_ANCHORS.github.enable);
		expect(anchors).not.toContain(GUIDE_ANCHORS.jira.enable);
		expect(anchors).not.toContain(GUIDE_ANCHORS.gitlab.enable);
		// The app-level AI-providers step has no project dependency, so it's
		// still offered.
		expect(anchors).toContain(GUIDE_ANCHORS.providers.configure);
	});

	it("produces an empty tour when there is no project and providers are already configured", () => {
		const status = computeSetupCategories({ anthropic: true }, null, false);
		expect(buildTodoTour(status)).toHaveLength(0);
	});

	it("leaves out a setup item it has no journey for", () => {
		const status = computeSetupCategories({}, env());
		status.categories[0].items.unshift({ id: "telemetry", state: "todo", deepLink: { kind: "app", section: "accounts" } });
		expect(buildTodoTour(status).map((s) => s.anchor)).toEqual(anchorsOf(computeSetupCategories({}, env())));
	});

	describe("the Next gates read the live project settings", () => {
		afterEach(() => {
			useProjectEnvStore.setState({ envConfig: null });
		});

		const gate = (anchor: string) => {
			const found = buildTodoTour(computeSetupCategories({}, env())).find((s) => s.anchor === anchor);
			if (!found?.condition) throw new Error(`no gate on ${anchor}`);
			return found.condition;
		};
		const setEnv = (overrides: Partial<ProjectEnvConfig>) =>
			useProjectEnvStore.setState({ envConfig: env(overrides) });

		it.each([
			[GUIDE_ANCHORS.github.enable, { githubEnabled: true }],
			[GUIDE_ANCHORS.github.token, { githubToken: "gho_test0000" }],
			[GUIDE_ANCHORS.gitlab.enable, { gitlabEnabled: true }],
			[GUIDE_ANCHORS.gitlab.token, { gitlabToken: "glpat-test0000" }],
			[GUIDE_ANCHORS.azureDevOps.enable, { azureDevOpsEnabled: true }],
			[GUIDE_ANCHORS.azureDevOps.orgUrl, { azureDevOpsOrgUrl: "https://dev.azure.com/example" }],
			[GUIDE_ANCHORS.azureDevOps.pat, { azureDevOpsPat: "pat-test0000" }],
			[GUIDE_ANCHORS.jira.enable, { jiraEnabled: true }],
			[GUIDE_ANCHORS.jira.instanceUrl, { jiraInstanceUrl: "https://example.atlassian.net" }],
			[GUIDE_ANCHORS.jira.email, { jiraEmail: "dev@example.com" }],
			[GUIDE_ANCHORS.jira.token, { jiraApiToken: "jira-test0000" }],
			[GUIDE_ANCHORS.linear.enable, { linearEnabled: true }],
			[GUIDE_ANCHORS.linear.apiKey, { linearApiKey: "lin_test0000" }],
			[GUIDE_ANCHORS.cicd.provider, { cicdProvider: "github" }],
			[GUIDE_ANCHORS.notifications.enable("slack"), { slackNotificationsEnabled: true }],
			[GUIDE_ANCHORS.notifications.webhook("slack"), { slackWebhookUrl: "https://hooks.example/x" }],
		] as [string, Partial<ProjectEnvConfig>][])("%s opens once its field is set", (anchor, filled) => {
			const condition = gate(anchor);
			expect(condition()).toBe(false);
			setEnv({});
			expect(condition()).toBe(false);
			setEnv(filled);
			expect(condition()).toBe(true);
		});

		it("does not count blanks as a value", () => {
			setEnv({ githubToken: "   " });
			expect(gate(GUIDE_ANCHORS.github.token)()).toBe(false);
		});

		it("does not count a disabled CI/CD as chosen", () => {
			setEnv({ cicdProvider: "none" });
			expect(gate(GUIDE_ANCHORS.cicd.provider)()).toBe(false);
		});
	});
});
