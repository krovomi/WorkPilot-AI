/**
 * The onboarding package as a document to read outside the app (#349).
 *
 * Written here because the translations live here: the document is in the
 * reader's language, for the role they picked. Main receives plain strings,
 * escapes them for Markdown or HTML and saves the file the user chose.
 */
import type { TFunction } from "i18next";
import type {
	OnboardingNarration,
	OnboardingPackage,
	OnboardingRole,
	OnboardingText,
} from "../../../preload/api/modules/onboarding-agent-api";
import type { OnboardingExportDocument, OnboardingExportSection } from "../../../shared/types/onboarding-export";

type Resolve = (value: OnboardingText | null | undefined, plain?: string) => string;

export interface ExportInput {
	pkg: OnboardingPackage;
	role: OnboardingRole;
	narration: OnboardingNarration | null;
	skipTour: boolean;
	lang: string;
	generatedAt: string;
	t: TFunction;
	resolve: Resolve;
}

export function buildExportDocument(input: ExportInput): OnboardingExportDocument {
	const { pkg, role, narration, skipTour, t, resolve } = input;
	const sections: OnboardingExportSection[] = [];
	const story = pkg.story;

	for (const chapter of story?.chapters ?? []) {
		sections.push({
			heading: resolve(chapter.title),
			intro: narration?.paragraphs?.[chapter.id] ?? "",
			lines: chapter.lines.map((line) => resolve(line)),
		});
	}

	if (!skipTour && pkg.tour.length) {
		const orders = story?.roles?.[role];
		const steps = orders ? pkg.tour.filter((step) => orders.includes(step.order)) : pkg.tour;
		sections.push({
			heading: `${t("onboardingAgent:tabs.tour")} — ${t(`onboardingAgent:roles.${role}`)}`,
			intro: "",
			lines: (steps.length ? steps : pkg.tour).map(
				(step) =>
					`${t("onboardingAgent:export.tourStep", {
						order: step.order,
						title: step.title,
						path: `\`${step.file_path}\``,
					})} — ${resolve(step.reason_i18n, step.reason)}`,
			),
		});
	}

	if (story?.hotspots.length) {
		sections.push({
			heading: t("onboardingAgent:storyView.hotspots"),
			intro: t("onboardingAgent:storyView.hotspotsIntro"),
			lines: story.hotspots.map((spot) =>
				t("onboardingAgent:export.hotspotLine", {
					path: `\`${spot.path}\``,
					risk: spot.risk,
					reasons: spot.reasons.map((reason) => resolve(reason)).join(", "),
				}),
			),
		});
	}

	if (pkg.guide.commands.length) {
		sections.push({
			heading: resolve({ key: "generated.step.workflows.title", params: {}, fallback: "Day-to-day commands" }),
			intro: "",
			lines: pkg.guide.commands.map((command) => `${resolve(command.label_i18n, command.label)}: \`${command.command}\``),
		});
	}

	if (pkg.guide.conventions.length) {
		sections.push({
			heading: resolve({ key: "generated.step.conventions.title", params: {}, fallback: "Coding conventions" }),
			intro: "",
			lines: pkg.guide.conventions.map(
				(c) => `${resolve(c.name_i18n, c.name)}: ${resolve(c.description_i18n, c.description)}`,
			),
		});
	}

	if (!skipTour && pkg.quiz.length) {
		sections.push({
			heading: t("onboardingAgent:tabs.quiz"),
			intro: "",
			lines: pkg.quiz.map((q) =>
				t("onboardingAgent:export.quizLine", {
					question: resolve(q.question_i18n, q.question),
					answer: resolve(q.choices_i18n?.[q.correct_index], q.choices[q.correct_index]),
				}),
			),
		});
	}

	if (pkg.first_tasks.length) {
		sections.push({
			heading: t("onboardingAgent:tabs.firstTasks"),
			intro: "",
			lines: pkg.first_tasks.map(
				(task) => `\`${task.file_path}:${task.line}\` — ${resolve(task.title_i18n, task.title)}`,
			),
		});
	}

	if (pkg.glossary.length) {
		sections.push({
			heading: t("onboardingAgent:tabs.glossary"),
			intro: "",
			lines: pkg.glossary.map((term) => `${term.term}: ${resolve(term.definition_i18n, term.definition)}`),
		});
	}

	return {
		title: pkg.guide.project_name,
		lang: input.lang,
		generatedAt: t("onboardingAgent:export.generatedAt", { date: input.generatedAt }),
		sections,
	};
}
