import { Flame, Landmark, Sparkles, TriangleAlert } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type {
	OnboardingChapterId,
	OnboardingHotspot,
} from "../../../preload/api/modules/onboarding-agent-api";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { Bar, CharterButton, Chip, Chips, Notice, ScanLine, StepCard, type Tone } from "../charter";
import { EmptyState, SectionTitle, useGeneratedText } from "./shared";

const CHAPTER_TONE: Record<OnboardingChapterId, Tone> = {
	structure: "blue",
	entry: "violet",
	critical: "orange",
	fragile: "red",
	decisions: "green",
};

const ZONE_TONE: Record<string, Tone> = {
	security: "red",
	billing: "amber",
	migrations: "violet",
	infrastructure: "blue",
};

function riskTone(risk: number): Tone {
	if (risk >= 60) return "red";
	if (risk >= 35) return "amber";
	return "muted";
}

/** The code's story: five chapters told from the repository, then the hot spots. */
export function StoryPanel({ projectPath }: { readonly projectPath?: string }): React.ReactElement | null {
	const { t, i18n } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const role = useOnboardingAgentStore((s) => s.role);
	const narration = useOnboardingAgentStore((s) => s.narration);
	const narrating = useOnboardingAgentStore((s) => s.narrating);
	const narrateError = useOnboardingAgentStore((s) => s.narrateError);
	const narrate = useOnboardingAgentStore((s) => s.narrate);
	const generated = useGeneratedText();

	if (!pkg) return null;
	const story = pkg.story;
	if (!story) return <EmptyState message={t("storyView.empty")} />;

	const areas = story.areas ?? {};
	const wanted: Record<string, string[]> = {
		frontend: ["ui"],
		backend: ["api", "data"],
		devops: ["infra"],
	};
	const forRole = (spot: OnboardingHotspot): boolean =>
		role === "fullstack" || (wanted[role] ?? []).includes(areas[spot.path] ?? "general");
	const ownSpots = story.hotspots.filter(forRole);
	const spots = ownSpots.length ? ownSpots : story.hotspots;
	const language = (i18n?.language || "en").slice(0, 2);

	return (
		<div className="flex max-w-4xl flex-col gap-4" data-testid="onboarding-story">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="wp-header-desc max-w-2xl">{t("storyView.intro")}</p>
				<CharterButton
					size="sm"
					icon={Sparkles}
					busy={narrating}
					disabled={!projectPath || narrating}
					onClick={() => projectPath && narrate(projectPath, language)}
				>
					{t("storyView.narrate")}
				</CharterButton>
			</div>
			{narrating && <ScanLine label={t("storyView.narrating")} />}
			{narrateError && (
				<Notice tone="red" icon={TriangleAlert} role="alert">
					{t("storyView.narrateFailed", { error: narrateError })}
				</Notice>
			)}
			{narration && !narration.answered && !narrating && (
				<Notice tone="amber" icon={TriangleAlert} role="status">
					{t("storyView.noAnswer")}
				</Notice>
			)}

			{story.chapters.map((chapter, index) => {
				const paragraph = narration?.paragraphs?.[chapter.id];
				return (
					<StepCard
						key={chapter.id}
						index={index + 1}
						tone={CHAPTER_TONE[chapter.id] ?? "muted"}
						kicker={generated(chapter.title)}
						title={paragraph ? <span className="font-normal">{paragraph}</span> : null}
					>
						<ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
							{chapter.lines.map((line) => (
								<li key={`${chapter.id}-${line.key}-${line.fallback}`} className="break-words">
									{generated(line)}
								</li>
							))}
						</ul>
					</StepCard>
				);
			})}

			<section aria-labelledby="onboarding-hotspots">
				<SectionTitle icon={<Flame />}>
					<span id="onboarding-hotspots">{t("storyView.hotspots")}</span>
				</SectionTitle>
				<p className="wp-meta mb-2 whitespace-normal">{t("storyView.hotspotsIntro")}</p>
				{spots.length === 0 ? (
					<EmptyState message={t("storyView.noHotspots")} />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="wp-kicker">
								<tr>
									<th className="py-1 pr-3">{t("storyView.columns.file")}</th>
									<th className="py-1 pr-3">{t("storyView.columns.risk")}</th>
									<th className="py-1 pr-3">{t("storyView.columns.commits")}</th>
									<th className="py-1 pr-3">{t("storyView.columns.authors")}</th>
									<th className="py-1 pr-3">{t("storyView.columns.complexity")}</th>
									<th className="py-1 pr-3">{t("storyView.columns.zones")}</th>
									<th className="py-1">{t("storyView.columns.tested")}</th>
								</tr>
							</thead>
							<tbody>
								{spots.map((spot) => (
									<tr key={spot.path} className="border-t border-border/50 align-top">
										<td className="max-w-[22rem] py-1.5 pr-3 font-mono text-xs break-all" title={spot.reasons.map((r) => generated(r)).join(" · ")}>
											{spot.path}
										</td>
										<td className="w-28 py-1.5 pr-3">
											<div className="flex items-center gap-2">
												<span className="tabular-nums">{spot.risk}</span>
												<Bar value={spot.risk} tone={riskTone(spot.risk)} />
											</div>
										</td>
										<td className="py-1.5 pr-3 tabular-nums">{spot.churn}</td>
										<td className="py-1.5 pr-3 tabular-nums">{spot.authors}</td>
										<td className="py-1.5 pr-3 tabular-nums">{spot.complexity}</td>
										<td className="py-1.5 pr-3">
											<Chips>
												{spot.danger.map((zone) => (
													<Chip key={zone} tone={ZONE_TONE[zone] ?? "muted"}>
														{t(`generated.story.danger.${zone}`)}
													</Chip>
												))}
											</Chips>
										</td>
										<td className="py-1.5">{spot.tested ? t("storyView.yes") : t("storyView.no")}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{story.decisions.length > 0 && (
				<section aria-labelledby="onboarding-decisions">
					<SectionTitle icon={<Landmark />}>
						<span id="onboarding-decisions">{t("storyView.decisions")}</span>
					</SectionTitle>
					<ul className="space-y-1.5 text-sm">
						{story.decisions.map((decision) => (
							<li key={`${decision.source}-${decision.ref || decision.path}-${decision.title}`} className="flex flex-wrap items-baseline gap-2">
								<Chip tone={decision.source === "adr" ? "green" : decision.source === "commit" ? "orange" : "violet"}>
									{t(`storyView.source.${decision.source}`)}
								</Chip>
								<span className="break-words">{decision.title}</span>
								{(decision.date || decision.path || decision.ref) && (
									<span className="wp-faint font-mono text-xs">
										{[decision.date, decision.ref, decision.path].filter(Boolean).join(" · ")}
									</span>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
