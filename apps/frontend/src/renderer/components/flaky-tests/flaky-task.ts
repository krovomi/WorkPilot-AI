/**
 * A flaky test turned into a Kanban card: fix it, or put it in quarantine (#351).
 *
 * The card carries the diagnosis (rate, verdict, causes and the lines that
 * show them, the error, the history) in the app's language, and what the task
 * must not do: a fix that skips the test, retries it or only lengthens a
 * timeout is no fix, and the test must still fail when the behaviour breaks.
 * The work then goes the Kanban's way: worktree, branch, QA, pull request, with
 * whichever provider the board runs.
 */
import type { FlakyStack, FlakyTest } from "../../../shared/types/flaky-tests";

type T = (key: string, opts?: Record<string, unknown>) => string;

export type FlakyTaskKind = "fix" | "quarantine";

export interface FlakyTaskSpec {
	title: string;
	description: string;
	acceptanceCriteria: string[];
}

const QUARANTINE_STACKS: FlakyStack[] = [
	"pytest",
	"vitest",
	"jest",
	"js",
	"dotnet",
	"jvm",
	"go",
	"rust",
	"ruby",
	"php",
	"swift",
	"dart",
	"elixir",
	"other",
];

function shortName(test: FlakyTest): string {
	const leaf = test.testName.split("::").pop() ?? test.testName;
	return leaf.length > 80 ? `${leaf.slice(0, 77)}…` : leaf;
}

function diagnosis(test: FlakyTest, t: T): string[] {
	const lines = [
		`- ${t("task.test")} \`${test.testName}\``,
		test.file ? `- ${t("task.where")} \`${test.file}:${test.line ?? 1}\`` : "",
		`- ${t("failedRuns", {
			failures: test.failures,
			total: test.totalRuns,
			rate: (test.flakinessRate * 100).toFixed(0),
		})}`,
		test.verdict ? `- ${t(`verdict.${test.verdict}`)}` : "",
		`- ${t("cause")} ${t(`causes.${test.probableCause}`)}`,
	];
	for (const cause of test.sourceCauses ?? []) {
		lines.push(`- ${t("task.seenInCode", { cause: t(`causes.${cause.cause}`) })}`);
		for (const proof of cause.evidence) lines.push(`  - \`${test.file}:${proof.line}\` \`${proof.text.replace(/`/g, "'")}\``);
	}
	const history = test.history;
	if (history?.firstSeen) {
		lines.push(`- ${t("history.firstSeen", { date: history.firstSeen.slice(0, 10) })}`);
		lines.push(`- ${t(`history.trend.${history.trend}`)}`);
	}
	if (history?.systems.length) lines.push(`- ${t("history.systems", { systems: history.systems.join(", ") })}`);
	if (history?.ciOnly) lines.push(`- ${t("history.ciOnly")}`);
	if (test.lastAuthor) lines.push(`- ${t("task.lastAuthor", { author: test.lastAuthor })}`);
	return lines.filter(Boolean);
}

export function buildFlakyTask(test: FlakyTest, kind: FlakyTaskKind, t: T): FlakyTaskSpec {
	const stack = QUARANTINE_STACKS.includes(test.stack ?? "other") ? (test.stack ?? "other") : "other";
	const parts = [
		t(`task.${kind}.intro`),
		"",
		`## ${t("task.diagnosis")}`,
		...diagnosis(test, t),
	];
	if (test.errorPatterns[0]) {
		parts.push("", `## ${t("errorSample")}`, "```", test.errorPatterns[0].slice(0, 1500), "```");
	}
	parts.push("", `## ${t("task.howTo")}`, t(kind === "fix" ? `fixes.${test.probableCause}` : `quarantine.${stack}`));
	parts.push("", `## ${t("task.rules")}`, ...t(`task.${kind}.rules`).split("\n").map((rule) => `- ${rule}`));
	return {
		title: t(`task.${kind}.title`, { name: shortName(test) }),
		description: parts.join("\n"),
		acceptanceCriteria: t(`task.${kind}.criteria`, { name: test.testName }).split("\n"),
	};
}
