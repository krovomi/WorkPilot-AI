/**
 * The `prod_incident` source: the project's incident inbox
 * (`<project>/.workpilot/incidents/*.json`) and, when the rule names a Sentry
 * project, the issues Sentry saw first after the rule. Read by the backend's
 * Regression Guardian runner in `--feed` mode, which writes each card's text
 * (the same text as on the server). Nothing listens on this machine: the
 * source is read on each pass, like the others.
 *
 * The Sentry token is the project's `SENTRY_AUTH_TOKEN` (the root `.env`, as
 * sentry-cli reads it, or `.workpilot/.env`, stored encrypted). It reaches the
 * runner in its environment, never on its command line, and the runner gets
 * no other credential (`pythonStaticRunnerEnv`).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import type {
	AutomationReason,
	AutomationRule,
	ProdIncidentTrigger,
	Project,
} from "../../shared/types";
import { readMergedProjectEnv } from "../ci-pipeline-service";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonStaticRunnerEnv } from "../utils/python-runner-env";
import { type AutomationEvent, SourceError, type SourceResult } from "./sources";

const RUNNER = "regression_guardian_runner.py";
const FEED_PREFIX = "REGRESSION_GUARDIAN_FEED:";
const FEED_ERROR_PREFIX = "REGRESSION_GUARDIAN_FEED_ERROR:";
const TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const KNOWN_REASONS: ReadonlySet<AutomationReason> = new Set([
	"incident_predates_rule",
	"incident_too_large",
	"incident_unreadable",
	"sentry_token_missing",
	"source_failed",
]);

/** The runner's request: the rule's trigger and the incident keys already seen. */
export interface FeedRequest {
	since: string;
	trigger: ProdIncidentTrigger;
	seen: string[];
}

/** Runs the feed for one project; the runner's stdout. Injected by tests. */
export type FeedRunner = (project: Project, request: FeedRequest) => Promise<string>;

export const runFeed: FeedRunner = async (project, request) => {
	const backend = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const python = await requirePythonPath();
	const token = readMergedProjectEnv(project).SENTRY_AUTH_TOKEN ?? "";
	const env = {
		...pythonStaticRunnerEnv(backend),
		...(request.trigger.org && token ? { SENTRY_AUTH_TOKEN: token } : {}),
	};
	return new Promise((resolve, reject) => {
		const child = spawn(
			python,
			[
				path.join(backend, "runners", RUNNER),
				"--project-path",
				project.path,
				"--feed",
				"--since",
				request.since,
			],
			{ cwd: backend, env, stdio: ["pipe", "pipe", "ignore"] },
		);
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new SourceError("source_failed", "The incident feed took too long"));
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			if (out.length > MAX_OUTPUT) child.kill("SIGTERM");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new SourceError("source_failed", err.message));
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
		child.stdin.end(JSON.stringify({ trigger: request.trigger, seen: request.seen }));
	});
};

function line(output: string, prefix: string): unknown {
	const found = output.split("\n").find((l) => l.startsWith(prefix));
	if (!found) return undefined;
	try {
		return JSON.parse(found.slice(prefix.length));
	} catch {
		return undefined;
	}
}

function oneLine(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * The rule's incidents not yet seen. The runner's answer is revalidated
 * here: an event is a fixed `incident:` key, one-line subject and title, and
 * the card text the runner wrote, nothing else.
 */
export async function prodIncidentEvents(
	rule: AutomationRule & { trigger: ProdIncidentTrigger },
	project: Project,
	seenKeys: string[],
	run: FeedRunner = runFeed,
): Promise<SourceResult> {
	const output = await run(project, {
		since: rule.createdAt,
		trigger: rule.trigger,
		seen: seenKeys.filter((key) => key.startsWith("incident:")),
	});
	const failure = line(output, FEED_ERROR_PREFIX) as
		| { reason?: unknown; message?: unknown }
		| undefined;
	if (failure) {
		const reason = KNOWN_REASONS.has(failure.reason as AutomationReason)
			? (failure.reason as AutomationReason)
			: "source_failed";
		throw new SourceError(reason, oneLine(failure.message, 300) || "The incident feed failed");
	}
	const feed = line(output, FEED_PREFIX) as
		| { events?: unknown; ignored?: unknown }
		| undefined;
	if (!feed || !Array.isArray(feed.events) || !Array.isArray(feed.ignored)) {
		throw new SourceError("source_failed", "The incident feed gave no answer");
	}
	const result: SourceResult = { events: [], ignored: [] };
	for (const raw of feed.events as Array<Record<string, unknown>>) {
		const key = oneLine(raw?.key, 200);
		const title = oneLine(raw?.title, 200);
		const description = typeof raw?.description === "string" ? raw.description.slice(0, 20_000) : "";
		if (!key.startsWith("incident:") || !title || !description) continue;
		const url = typeof raw.url === "string" && raw.url.startsWith("https://") ? raw.url : undefined;
		const event: AutomationEvent = {
			key,
			subject: oneLine(raw.subject, 120) || key,
			title,
			description,
			...(url && { url }),
		};
		result.events.push(event);
	}
	for (const raw of feed.ignored as Array<Record<string, unknown>>) {
		const key = oneLine(raw?.key, 200);
		const reason = raw?.reason as AutomationReason;
		if (!key.startsWith("incident:") || !KNOWN_REASONS.has(reason)) continue;
		result.ignored.push({ key, subject: oneLine(raw.subject, 120) || key, reason });
	}
	return result;
}
