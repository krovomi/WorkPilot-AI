/**
 * The i18n page's new parts (#346): completeness per locale, the key
 * proposed for a hard-coded string, and the translation on a review card,
 * which a server project cannot start from this computer.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nIssue, I18nReport } from "../../../../shared/types/i18n-agent";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : options && "key" in options ? `${key}:${options.key}` : key,
		i18n: { language: "fr-FR" },
	}),
}));

import { useI18nAgentStore } from "../../../stores/i18n-agent-store";
import { I18nCompletenessSection } from "../I18nCompletenessSection";
import { I18nIssueCard, issueMessage } from "../I18nIssueCard";

const hardcoded: I18nIssue = {
	issueType: "hardcoded_string",
	severity: "warning",
	file: "src/components/settings/PrivacyPanel.tsx",
	line: 6,
	key: "settings.privacyPanel.shareAnonymousBenchmarks",
	locale: "",
	message: 'Hardcoded string: "Share anonymous benchmarks"',
	suggestion: "",
	text: "Share anonymous benchmarks",
	proposedKey: "settings.privacyPanel.shareAnonymousBenchmarks",
	proposedValue: "Share anonymous benchmarks",
	snippet: '{t("settings.privacyPanel.shareAnonymousBenchmarks")}',
};

const report: I18nReport = {
	filesScanned: 3,
	localesCompared: ["ar", "en", "fr"],
	issues: [hardcoded],
	coverageByLocale: { fr: 66.7 },
	summary: "",
	referenceLocale: "en",
	completeness: [
		{ locale: "fr", total: 6, present: 4, untranslated: 1, missing: 2, score: 50, rtl: false },
		{ locale: "ar", total: 6, present: 2, untranslated: 0, missing: 4, score: 33.3, rtl: true },
	],
	translatable: { fr: 2, ar: 4 },
	rtlLocales: ["ar"],
};

describe("I18nIssueCard", () => {
	it("shows the proposed key and the call to paste", () => {
		render(<I18nIssueCard issue={hardcoded} rtl={[]} />);

		expect(screen.getByText("settings.privacyPanel.shareAnonymousBenchmarks")).toBeTruthy();
		expect(screen.getByText('{t("settings.privacyPanel.shareAnonymousBenchmarks")}')).toBeTruthy();
		expect(screen.getByRole("button", { name: "proposal.copySnippet" })).toBeTruthy();
	});

	it("words an uncertain orphan differently", () => {
		const t = (key: string) => key;
		const orphan = { ...hardcoded, issueType: "orphan_key" as const, possibly: true };

		expect(issueMessage(t, orphan, [])).toBe("messages.orphan_key_possibly");
		expect(issueMessage(t, { ...orphan, possibly: false }, [])).toBe("messages.orphan_key");
	});
});

describe("I18nCompletenessSection", () => {
	beforeEach(() => {
		useI18nAgentStore.setState({ translating: false, translation: null, translateError: null });
	});

	it("scores each locale and offers the translation on a review card", () => {
		const translate = vi.fn();
		useI18nAgentStore.setState({ translate });
		render(<I18nCompletenessSection report={report} projectPath="/p" local />);

		expect(screen.getByText("completeness.rtl")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "translate.action:6" }));
		expect(translate).toHaveBeenCalledWith("/p");
	});

	it("cannot translate a server project from this computer", () => {
		render(<I18nCompletenessSection report={report} projectPath="/p" local={false} />);

		expect((screen.getByRole("button", { name: "translate.action:6" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("says where the translations went", () => {
		useI18nAgentStore.setState({
			translation: {
				added: 2,
				written: [{ file: "public/locales/fr/common.json", locale: "fr", count: 2 }],
				rejected: 0,
				skipped: 0,
				answered: true,
				notWritable: [],
				review: {
					taskId: "4",
					specId: "4",
					title: "Traductions",
					branch: "workpilot/004-i18n",
					baseBranch: "develop",
					files: [],
					committed: true,
					reused: false,
				},
			},
		});
		render(<I18nCompletenessSection report={report} projectPath="/p" local />);

		expect(screen.getByRole("status").textContent).toContain("translate.done:2");
	});
});
