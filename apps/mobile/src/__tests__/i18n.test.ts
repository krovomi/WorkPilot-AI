import en from "../i18n/en.json";
import fr from "../i18n/fr.json";
import i18n, { describeError, pickLanguage } from "../i18n";
import { orgRoleLabel, phaseLabel, projectRoleLabel, statusLabel } from "../i18n/labels";
import { ApiError } from "../api/client";

function keys(value: unknown, prefix = ""): string[] {
	if (!value || typeof value !== "object") return [prefix];
	return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n", () => {
	it("has every key in English and French", () => {
		expect(keys(fr).sort()).toEqual(keys(en).sort());
	});

	it("leaves no text empty", () => {
		for (const pack of [en, fr]) {
			const flat = keys(pack);
			for (const key of flat) {
				const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], pack);
				expect(typeof text === "string" && text.trim().length > 0).toBe(true);
			}
		}
	});

	it("picks the device's first language it speaks", () => {
		expect(pickLanguage(["de-DE", "fr-CA"])).toBe("fr");
		expect(pickLanguage(["ja"])).toBe("en");
		expect(pickLanguage([null, undefined])).toBe("en");
	});

	it("turns failures into sentences", () => {
		expect(describeError(new ApiError(0, "network"))).toBe(en.errors.network);
		expect(describeError(new ApiError(403, "Missing permission"))).toBe(en.errors.forbidden);
		expect(describeError(new ApiError(429, "HTTP 429"))).toBe(en.errors.too_many);
		expect(describeError(new ApiError(409, "Busy"))).toBe("Something went wrong: Busy");
		expect(describeError(new Error("feedback_required"))).toBe(en.errors.feedback_required);
	});
});

describe("labels for server keys", () => {
	it("names every board status the dashboard can show", () => {
		for (const status of ["queue", "build_failed", "pr_created", "in_progress", "done", "backlog"]) {
			expect(statusLabel(status)).not.toBe(status);
		}
	});

	it("names feature jobs, analyses and forge reviews in work sessions", () => {
		for (const phase of ["build", "roadmap", "ideation", "insights", "context", "analysis-tech-debt", "github-review"]) {
			expect(phaseLabel(phase)).not.toBe(phase);
		}
		expect(phaseLabel("something-new")).toBe("something-new");
	});

	it("names roles, and keeps a custom role's slug", async () => {
		await i18n.changeLanguage("fr");
		expect(projectRoleLabel("owner")).toBe("Propriétaire");
		expect(orgRoleLabel("contributor")).toBe("Contributeur");
		expect(orgRoleLabel("release-managers")).toBe("release-managers");
		await i18n.changeLanguage("en");
	});
});
