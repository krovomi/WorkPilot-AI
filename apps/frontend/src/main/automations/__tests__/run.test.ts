/**
 * A pass creates a card once per event, holds back what the daily cap does
 * not allow, keeps one card per CI red streak, and says when a source
 * cannot be read — once, not on every pass.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRule, Project } from "../../../shared/types";
import { createAutomationCard, issueNumbersOnBoard } from "../cards";
import { parseRule } from "../rules";
import { type RunDeps, runProjectAutomations } from "../run";
import { type AutomationEvent, type SourceResult, SourceError } from "../sources";
import { readLedger, writeRules } from "../store";

let root: string;
let project: Project;
let now: Date;
let source: (rule: AutomationRule) => SourceResult | Promise<SourceResult>;
let started: string[];
let open: Set<string>;

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
	return {
		now: () => now,
		readSource: async (_project, rule) => source(rule),
		createCard: createAutomationCard,
		startCard: (_project, card) => {
			started.push(card.specId);
		},
		isCardOpen: (_project, specId) => open.has(specId),
		issueNumbersOnBoard,
		...overrides,
	};
}

function addRule(raw: object): AutomationRule {
	const rule = parseRule(raw, undefined, new Date("2026-10-01T00:00:00Z")) as AutomationRule;
	if (typeof rule === "string") throw new Error(rule);
	writeRules(project, [rule]);
	return rule;
}

const issueEvent = (n: number): AutomationEvent => ({
	key: `github-issue:acme/app#${n}`,
	subject: `#${n}`,
	title: `Issue ${n}`,
	description: `Body ${n}`,
	url: `https://github.com/acme/app/issues/${n}`,
	issue: { number: n, url: `https://github.com/acme/app/issues/${n}`, labels: ["bug"] },
});

function metadata(specId: string) {
	return JSON.parse(
		readFileSync(path.join(root, ".workpilot", "specs", specId, "task_metadata.json"), "utf-8"),
	);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "automations-"));
	project = { id: "p1", name: "p", path: root, autoBuildPath: ".workpilot", settings: {} } as unknown as Project;
	now = new Date(2026, 9, 26, 10, 0);
	started = [];
	open = new Set();
	source = () => ({ events: [], ignored: [] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("runProjectAutomations", () => {
	it("creates a draft card once per event, with the rule's kind and engine", async () => {
		addRule({
			name: "Issues",
			trigger: { type: "issue_labeled", label: "wp" },
			kind: "bug_fix",
			engine: { provider: "openai", model: "model-b", effort: "medium" },
		});
		source = () => ({ events: [issueEvent(7)], ignored: [] });

		expect(await runProjectAutomations(project, deps())).toEqual({ created: 1, errors: 0 });
		expect(await runProjectAutomations(project, deps())).toEqual({ created: 0, errors: 0 });

		const ledger = readLedger(project);
		const [entry] = Object.values(ledger.seen);
		expect(entry.outcome).toBe("created");
		expect(started).toEqual([]);
		const card = metadata(entry.specId as string);
		expect(card).toMatchObject({
			sourceType: "github",
			githubIssueNumber: 7,
			kind: "bug_fix",
			kindSource: "user",
			engineLocked: true,
			provider: "openai",
			phaseModels: { spec: "model-b", planning: "model-b", coding: "model-b", qa: "model-b" },
			automation: { ruleName: "Issues", eventKey: "github-issue:acme/app#7" },
		});
		const plan = JSON.parse(
			readFileSync(path.join(root, ".workpilot", "specs", entry.specId as string, "implementation_plan.json"), "utf-8"),
		);
		// A pending plan: the card waits in the backlog like a typed one.
		expect(plan).toMatchObject({ feature: "Issue 7", status: "pending", phases: [] });
	});

	it("starts the card when the rule is not a draft, and says when the start failed", async () => {
		addRule({ name: "Go", trigger: { type: "issue_labeled", label: "wp" }, draft: false });
		source = () => ({ events: [issueEvent(1)], ignored: [] });
		await runProjectAutomations(project, deps());
		expect(started).toHaveLength(1);
		expect(readLedger(project).activity.at(-1)?.outcome).toBe("started");

		source = () => ({ events: [issueEvent(2)], ignored: [] });
		await runProjectAutomations(
			project,
			deps({
				startCard: () => {
					throw new Error("no auth");
				},
			}),
		);
		const last = readLedger(project).activity.at(-1);
		expect(last).toMatchObject({ outcome: "created", reason: "not_started", detail: "no auth" });
	});

	it("holds events over the daily cap until the next day, without losing them", async () => {
		addRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" }, dailyCap: 2 });
		source = () => ({ events: [issueEvent(1), issueEvent(2), issueEvent(3)], ignored: [] });

		expect((await runProjectAutomations(project, deps())).created).toBe(2);
		let ledger = readLedger(project);
		const ruleId = Object.keys(ledger.statuses)[0];
		expect(ledger.statuses[ruleId]).toMatchObject({ createdToday: 2, deferred: 1 });
		expect((await runProjectAutomations(project, deps())).created).toBe(0);

		now = new Date(2026, 9, 27, 10, 0);
		expect((await runProjectAutomations(project, deps())).created).toBe(1);
		ledger = readLedger(project);
		expect(ledger.statuses[ruleId]).toMatchObject({ createdToday: 1, deferred: 0 });
		expect(Object.keys(ledger.created[ruleId])).toEqual(["2026-10-27"]);
	});

	it("does not import an issue the board already has a card for", async () => {
		addRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" } });
		source = () => ({ events: [issueEvent(5)], ignored: [] });
		await runProjectAutomations(project, deps());
		// A second rule on another label sees the same issue.
		const other = parseRule({ name: "Other", trigger: { type: "issue_labeled", label: "bug" } }) as AutomationRule;
		writeRules(project, [other]);
		source = () => ({ events: [{ ...issueEvent(5), key: "github-issue:acme/app#5-other" }], ignored: [] });
		expect((await runProjectAutomations(project, deps())).created).toBe(0);
		expect(readLedger(project).activity.at(-1)).toMatchObject({ outcome: "duplicate", reason: "issue_on_board" });
	});

	it("keeps one card per CI red streak, and opens a new one after green", async () => {
		addRule({ name: "CI", trigger: { type: "ci_failed" } });
		const run = (id: number): SourceResult => ({
			events: [{ key: `ci:gh:main:${id}`, subject: `CI #${id}`, title: "Fix CI on main", description: "red" }],
			ignored: [],
		});
		source = () => run(1);
		await runProjectAutomations(project, deps());
		const first = Object.values(readLedger(project).seen)[0].specId as string;
		open.add(first);

		source = () => run(2);
		expect((await runProjectAutomations(project, deps())).created).toBe(0);
		expect(readLedger(project).activity.at(-1)).toMatchObject({ reason: "streak_open", specId: first });

		source = () => ({ events: [], ignored: [], green: true });
		await runProjectAutomations(project, deps());
		source = () => run(3);
		expect((await runProjectAutomations(project, deps())).created).toBe(1);
	});

	it("opens a new card when the streak's card was closed but CI is still red", async () => {
		addRule({ name: "CI", trigger: { type: "ci_failed" } });
		source = () => ({
			events: [{ key: "ci:gh:main:1", subject: "CI #1", title: "Fix CI", description: "red" }],
			ignored: [],
		});
		await runProjectAutomations(project, deps());
		source = () => ({
			events: [{ key: "ci:gh:main:2", subject: "CI #2", title: "Fix CI", description: "red" }],
			ignored: [],
		});
		// The first card is done (not open): the fix did not hold.
		expect((await runProjectAutomations(project, deps())).created).toBe(1);
	});

	it("names a source it cannot read, once, and clears it when the source answers", async () => {
		addRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" } });
		source = () => {
			throw new SourceError("github_not_connected", "GitHub is not connected");
		};
		expect(await runProjectAutomations(project, deps())).toEqual({ created: 0, errors: 1 });
		await runProjectAutomations(project, deps());
		let ledger = readLedger(project);
		const ruleId = Object.keys(ledger.statuses)[0];
		expect(ledger.statuses[ruleId].lastError).toBe("github_not_connected");
		expect(ledger.activity.filter((a) => a.outcome === "error")).toHaveLength(1);

		source = () => ({ events: [], ignored: [] });
		await runProjectAutomations(project, deps());
		ledger = readLedger(project);
		expect(ledger.statuses[ruleId].lastError).toBeUndefined();
	});

	it("retries an event whose card could not be written", async () => {
		addRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" } });
		source = () => ({ events: [issueEvent(4)], ignored: [] });
		const failing = vi.fn(async () => {
			throw new Error("disk full");
		});
		expect(await runProjectAutomations(project, deps({ createCard: failing }))).toEqual({ created: 0, errors: 1 });
		expect(readLedger(project).seen).toEqual({});
		expect((await runProjectAutomations(project, deps())).created).toBe(1);
	});

	it("remembers ignored events so they are not read again", async () => {
		addRule({ name: "Issues", trigger: { type: "issue_labeled", label: "wp" } });
		source = () => ({ events: [], ignored: [{ key: "github-issue:acme/app#2", subject: "#2", reason: "label_predates_rule" }] });
		await runProjectAutomations(project, deps());
		expect(readLedger(project).seen["github-issue:acme/app#2"].outcome).toBe("ignored");
	});

	it("does nothing for a project without an enabled rule", async () => {
		const rule = addRule({ name: "Off", enabled: false, trigger: { type: "ci_failed" } });
		const readSource = vi.fn();
		expect(await runProjectAutomations(project, deps({ readSource }))).toEqual({ created: 0, errors: 0 });
		expect(readSource).not.toHaveBeenCalled();
		expect(rule.enabled).toBe(false);
	});
});
