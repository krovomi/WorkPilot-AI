/**
 * Server mode: setting a card aside reaches the server, so every member sees
 * it in « Abandonnée »; resuming clears it there too.
 */
import { describe, expect, it } from "vitest";
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
