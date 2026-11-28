/**
 * Server mode: setting a card aside reaches the server, so every member sees
 * it in « Abandonnée »; resuming clears it there too.
 */
import { describe, expect, it } from "vitest";
import { buildFlagMetadata, buildUnflagMetadata } from "../../shared/utils/task-flag";
import { buildAbandonMetadata, buildResumeMetadata } from "../../shared/utils/task-lifecycle";
import { settingsFromMetadata } from "../server-card-settings";

describe("settingsFromMetadata, abandon", () => {
	it("sends the abandon, its reason, resolution and linked task", () => {
		const now = new Date("2026-11-22T10:00:00.000Z");
		const patch = buildAbandonMetadata(
			{ reason: "covered elsewhere", resolution: "replaced", link: "server:p:002-auth" },
			now,
		);
		expect(settingsFromMetadata(patch)).toEqual({
			abandoned: true,
			abandonedAt: "2026-11-22T10:00:00.000Z",
			abandonedReason: "covered elsewhere",
			abandonedResolution: "replaced",
			abandonedLink: "server:p:002-auth",
		});
	});

	it("clears them on resume, keeping the date", () => {
		expect(settingsFromMetadata(buildResumeMetadata())).toEqual({
			abandoned: false,
			abandonedReason: null,
			abandonedResolution: null,
			abandonedLink: null,
		});
		expect(settingsFromMetadata({ abandoned: undefined })).toEqual({ abandoned: null });
	});
});

describe("settingsFromMetadata, flag", () => {
	it("sends the « Bloquée » flag, and clears it when lifted", () => {
		const now = new Date("2026-11-22T10:00:00.000Z");
		expect(settingsFromMetadata(buildFlagMetadata("waiting", now))).toEqual({
			flagged: true,
			flaggedAt: "2026-11-22T10:00:00.000Z",
			flaggedReason: "waiting",
		});
		expect(settingsFromMetadata(buildUnflagMetadata())).toEqual({
			flagged: false,
			flaggedReason: null,
			flaggedAt: null,
		});
		expect(settingsFromMetadata({ flagged: undefined })).toEqual({ flagged: null });
	});
});

describe("settingsFromMetadata, labels", () => {
	it("sends the labels, and clears them when none is left", () => {
		expect(settingsFromMetadata({ labels: ["front", "release"] })).toEqual({ labels: ["front", "release"] });
		expect(settingsFromMetadata({ labels: [] })).toEqual({ labels: null });
	});
});
