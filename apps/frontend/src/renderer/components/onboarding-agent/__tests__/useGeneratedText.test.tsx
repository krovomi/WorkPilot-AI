/**
 * The resolver for backend-generated strings.
 *
 * The onboarding package is written in Python: its prose arrives as an i18n
 * key plus parameters, and this hook is the only place that turns it back into
 * a sentence. These tests pin the three cases that matter — a plain key, a key
 * whose parameter is itself a key, and a value that must not be translated.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingText } from "../../../../preload/api/modules/onboarding-agent-api";
import { useGeneratedText } from "../shared";

const DICTIONARY: Record<string, string> = {
	"generated.role.domain": "Couche domaine",
	"generated.quiz.directoryHolds.question": "Que contient `{{path}}/` ?",
	"generated.quiz.directoryHolds.rationale": "`{{path}}/` — {{role}}",
};

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options: Record<string, unknown> = {}) => {
			const template = DICTIONARY[key];
			if (template === undefined) return String(options.defaultValue ?? key);
			return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
				String(options[name] ?? ""),
			);
		},
	}),
}));

function descriptor(
	key: string,
	params: Record<string, unknown> = {},
	fallback = "",
): OnboardingText {
	return { key, params, fallback };
}

function resolver() {
	return renderHook(() => useGeneratedText()).result.current;
}

describe("useGeneratedText", () => {
	it("translates a key", () => {
		expect(resolver()(descriptor("generated.role.domain", {}, "Domain layer"))).toBe(
			"Couche domaine",
		);
	});

	it("interpolates plain parameters", () => {
		const value = descriptor(
			"generated.quiz.directoryHolds.question",
			{ path: "src/Shop.Domain" },
			"What does `src/Shop.Domain/` hold?",
		);

		expect(resolver()(value)).toBe("Que contient `src/Shop.Domain/` ?");
	});

	it("resolves a parameter that is itself a descriptor", () => {
		const value = descriptor(
			"generated.quiz.directoryHolds.rationale",
			{
				path: "src/Shop.Domain",
				role: descriptor("generated.role.domain", {}, "Domain layer"),
			},
			"`src/Shop.Domain/` — Domain layer",
		);

		expect(resolver()(value)).toBe("`src/Shop.Domain/` — Couche domaine");
	});

	it("leaves a raw value alone", () => {
		// An empty key marks a path, a command or a tool name: translating it
		// would rename the thing it points at.
		expect(resolver()(descriptor("", {}, "dotnet test"))).toBe("dotnet test");
	});

	it("falls back to English when the locale has no such key", () => {
		const value = descriptor("generated.role.unheardOf", {}, "Project code");

		expect(resolver()(value)).toBe("Project code");
	});

	it("returns the plain text when there is no descriptor at all", () => {
		expect(resolver()(null, "Domain layer")).toBe("Domain layer");
		expect(resolver()(undefined)).toBe("");
	});
});
