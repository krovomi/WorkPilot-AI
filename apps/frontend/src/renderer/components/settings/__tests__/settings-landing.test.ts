/**
 * Where the settings dialog opens.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { resolveSettingsLanding } from "../settings-landing";

describe("resolveSettingsLanding", () => {
	it("lands on Général when nothing else was asked for", () => {
		expect(
			resolveSettingsLanding({ hasProjectToShow: true, hasLanded: false }),
		).toEqual({ topLevel: "project", projectSection: "general", landed: true });
	});

	it("honours an explicit project section over the default", () => {
		expect(
			resolveSettingsLanding({
				initialProjectSection: "github",
				hasProjectToShow: true,
				hasLanded: false,
			}),
		).toEqual({ topLevel: "project", projectSection: "github", landed: true });
	});

	it("honours an explicit app section over the default", () => {
		expect(
			resolveSettingsLanding({
				initialSection: "accounts",
				hasProjectToShow: true,
				hasLanded: false,
			}),
		).toEqual({ topLevel: "app", appSection: "accounts", landed: true });
	});

	it("prefers the project section when a caller names both", () => {
		const landing = resolveSettingsLanding({
			initialSection: "accounts",
			initialProjectSection: "gitlab",
			hasProjectToShow: true,
			hasLanded: false,
		});
		expect(landing?.topLevel).toBe("project");
		expect(landing?.projectSection).toBe("gitlab");
	});

	it("falls back to the app pane when no project can be rendered", () => {
		expect(
			resolveSettingsLanding({ hasProjectToShow: false, hasLanded: false }),
		).toEqual({ topLevel: "app", landed: false });
	});

	it("is not settled by that fallback, so a late project still lands", () => {
		// The cold-open sequence: no project on the first pass, one on the second.
		const first = resolveSettingsLanding({
			hasProjectToShow: false,
			hasLanded: false,
		});
		expect(first?.landed).toBe(false);

		const second = resolveSettingsLanding({
			hasProjectToShow: true,
			hasLanded: first?.landed ?? false,
		});
		expect(second).toEqual({
			topLevel: "project",
			projectSection: "general",
			landed: true,
		});
	});

	it("leaves a settled dialog alone when its inputs change again", () => {
		// The user navigated away after landing; a re-run must not pull them back.
		expect(
			resolveSettingsLanding({ hasProjectToShow: true, hasLanded: true }),
		).toBeNull();
	});

	it("still re-applies an explicit target on a settled dialog", () => {
		// Deep links (the guided tour) fire while the dialog is already open.
		expect(
			resolveSettingsLanding({
				initialProjectSection: "memory",
				hasProjectToShow: true,
				hasLanded: true,
			}),
		).toEqual({ topLevel: "project", projectSection: "memory", landed: true });
	});
});
