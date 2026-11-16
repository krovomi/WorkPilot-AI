/**
 * @vitest-environment node
 *
 * The auto-fix handlers' arguments, checked before a handler runs: an issue
 * number or a list of them is a positive integer, the configuration has the
 * shape the app writes, and an approved batch names its issues by number.
 */

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { autofixArgsAllowed } from "../autofix-ipc-guard";

const NOT_NUMBERS: unknown[] = ["12", "--project", 0, -4, 2.5, Number.NaN, null, {}];
const allowed = (channel: string, ...args: unknown[]) => autofixArgsAllowed(channel, ["p", ...args]);

const CONFIG = {
	enabled: true,
	labels: ["auto-fix", "bug"],
	requireHumanApproval: true,
	model: "sonnet",
	thinkingLevel: "medium",
};
const BATCH = {
	primaryIssue: 4,
	issues: [{ issueNumber: 4, title: "Crash", labels: [], similarityToPrimary: 1 }],
	theme: "crash",
};

describe("autofixArgsAllowed", () => {
	it("takes one issue number to fix", () => {
		expect(allowed(IPC_CHANNELS.GITHUB_AUTOFIX_START, 42)).toBe(true);
		for (const bad of [...NOT_NUMBERS, undefined]) expect(allowed(IPC_CHANNELS.GITHUB_AUTOFIX_START, bad)).toBe(false);
	});

	it("takes a bounded list of issue numbers, or none for every labelled issue", () => {
		for (const channel of [IPC_CHANNELS.GITHUB_AUTOFIX_BATCH, IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW]) {
			expect(allowed(channel, [1, 2])).toBe(true);
			expect(allowed(channel, undefined)).toBe(true);
			expect(allowed(channel, [1, "--project"])).toBe(false);
			expect(allowed(channel, "1 2")).toBe(false);
			expect(allowed(channel, Array.from({ length: 501 }, (_, i) => i + 1))).toBe(false);
		}
	});

	it("takes a positive number as the most issues a preview analyzes", () => {
		const preview = IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW;
		expect(allowed(preview, undefined, 50)).toBe(true);
		for (const bad of NOT_NUMBERS) expect(allowed(preview, undefined, bad)).toBe(false);
	});

	it("takes the configuration the app writes, and nothing else", () => {
		const save = IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG;
		expect(allowed(save, CONFIG)).toBe(true);
		expect(allowed(save, { ...CONFIG, labels: [] })).toBe(true);
		for (const bad of [
			null,
			[CONFIG],
			{ ...CONFIG, enabled: "yes" },
			{ ...CONFIG, requireHumanApproval: 1 },
			{ ...CONFIG, labels: "auto-fix" },
			{ ...CONFIG, labels: [""] },
			{ ...CONFIG, labels: ["x".repeat(51)] },
			{ ...CONFIG, labels: Array.from({ length: 101 }, (_, i) => `l${i}`) },
			{ ...CONFIG, model: "" },
			{ ...CONFIG, model: "m".repeat(201) },
			{ ...CONFIG, thinkingLevel: 3 },
		]) {
			expect(allowed(save, bad)).toBe(false);
		}
	});

	it("takes approved batches that name their issues by number", () => {
		const approve = IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES;
		expect(allowed(approve, [BATCH])).toBe(true);
		expect(allowed(approve, [])).toBe(true);
		for (const bad of [
			BATCH,
			[null],
			[{ ...BATCH, primaryIssue: "4" }],
			[{ ...BATCH, issues: "4" }],
			[{ ...BATCH, issues: [{ issueNumber: "4/../x", title: "Crash" }] }],
			[{ ...BATCH, issues: [{ issueNumber: 4, title: 4 }] }],
			Array.from({ length: 101 }, () => BATCH),
		]) {
			expect(allowed(approve, bad)).toBe(false);
		}
	});

	it("leaves the channels that take only the project alone", () => {
		expect(allowed(IPC_CHANNELS.GITHUB_AUTOFIX_GET_QUEUE)).toBe(true);
	});
});
