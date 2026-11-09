import {
	BookOpen,
	BookOpenText,
	Download,
	EyeOff,
	FileCode,
	FolderTree,
	History,
	LayoutDashboard,
	ListChecks,
	Map as MapIcon,
	MessageCircleQuestion,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingExportFormat } from "../../../shared/types/onboarding-export";
import { formatAppDateTime } from "../../lib/date-format";
import type { OnboardingAgentTab } from "../../stores/onboarding-agent-store";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import {
	CharterButton,
	Chip,
	Chips,
	Column,
	Columns,
	Composer,
	ModuleHeader,
	ModuleStage,
	Notice,
	ScanLine,
	StepCard,
	type Tone,
} from "../charter";
import { useGeneratedText } from "./shared";
import { ArchitecturePanel } from "./ArchitecturePanel";
import { buildExportDocument } from "./export-tour";
import { FirstTasksPanel } from "./FirstTasksPanel";
import { GlossaryPanel } from "./GlossaryPanel";
import { OverviewPanel } from "./OverviewPanel";
import { QuizPanel } from "./QuizPanel";
import { StoryPanel } from "./StoryPanel";
import { TourPanel } from "./TourPanel";

interface OnboardingPackageViewProps {
	readonly projectPath?: string;
}

export function OnboardingPackageView({
	projectPath,
}: OnboardingPackageViewProps): React.ReactElement | null {
	const { t, i18n } = useTranslation(["onboardingAgent", "common"]);

	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const phase = useOnboardingAgentStore((s) => s.phase);
	const status = useOnboardingAgentStore((s) => s.status);
	const statusI18n = useOnboardingAgentStore((s) => s.statusI18n);
	const error = useOnboardingAgentStore((s) => s.error);
	const errorKey = useOnboardingAgentStore((s) => s.errorKey);
	const generated = useGeneratedText();
	const tab = useOnboardingAgentStore((s) => s.activeTab);
	const setTab = useOnboardingAgentStore((s) => s.setActiveTab);
	const startScan = useOnboardingAgentStore((s) => s.startScan);
	const reset = useOnboardingAgentStore((s) => s.reset);
	const checkFreshness = useOnboardingAgentStore((s) => s.checkFreshness);
	const regenerated = useOnboardingAgentStore((s) => s.regenerated);
	const skipTour = useOnboardingAgentStore((s) => s.skipTour);
	const setSkipTour = useOnboardingAgentStore((s) => s.setSkipTour);
	const role = useOnboardingAgentStore((s) => s.role);
	const narration = useOnboardingAgentStore((s) => s.narration);
	const [exportNotice, setExportNotice] = useState<{ tone: Tone; text: string } | null>(null);

	// A tour that no longer fits the project is made again (#349): on opening
	// the page and whenever the project changes.
	useEffect(() => {
		if (projectPath) void checkFreshness(projectPath);
	}, [projectPath, checkFreshness]);

	const isScanning = phase === "scanning";

	const exportTour = async (format: OnboardingExportFormat): Promise<void> => {
		if (!pkg) return;
		setExportNotice(null);
		const document = buildExportDocument({
			pkg,
			role,
			narration,
			skipTour,
			lang: (i18n?.language || "en").slice(0, 2),
			generatedAt: formatAppDateTime(new Date(), { dateStyle: "long", timeStyle: "short" }),
			t,
			resolve: generated,
		});
		try {
			const outcome = await globalThis.electronAPI.exportOnboardingTour({ format, document });
			if (outcome.saved && outcome.path) {
				setExportNotice({ tone: "green", text: t("onboardingAgent:export.saved", { path: outcome.path }) });
			}
		} catch (err) {
			setExportNotice({
				tone: "red",
				text: t("onboardingAgent:export.failed", { error: err instanceof Error ? err.message : String(err) }),
			});
		}
	};

	const runButton = (
		<CharterButton
			variant="primary"
			icon={BookOpen}
			onClick={() => projectPath && startScan(projectPath)}
			disabled={!projectPath}
		>
			{t("onboardingAgent:actions.runScan")}
		</CharterButton>
	);

	if (!pkg) {
		const pitches: Array<{ key: string; tone: Tone }> = [
			{ key: "overview", tone: "blue" },
			{ key: "story", tone: "orange" },
			{ key: "tour", tone: "violet" },
			{ key: "quiz", tone: "amber" },
			{ key: "tasks", tone: "green" },
			{ key: "glossary", tone: "pink" },
		];
		return (
			<ModuleStage data-testid="onboarding-package-view">
				<Columns template="minmax(0, 1fr)">
					<Column kicker={t("onboardingAgent:kickers.package")} title={t("onboardingAgent:packageTitle")}>
						<div className="flex max-w-3xl flex-col gap-3">
							<p className="wp-header-desc">{t("onboardingAgent:packageIntro")}</p>
							{isScanning && (
								<ScanLine
									label={generated(statusI18n, status) || t("onboardingAgent:actions.scanning")}
								/>
							)}
							{phase === "error" && (
								<Notice tone="red" icon={TriangleAlert} role="alert">
									{errorKey
										? t(`onboardingAgent:${errorKey}`)
										: t("onboardingAgent:errors.failed", { error: error ?? "" })}
								</Notice>
							)}
							{pitches.map((p, i) => (
								<StepCard
									key={p.key}
									index={i + 1}
									tone={p.tone}
									kicker={t(`onboardingAgent:tabs.${p.key === "tasks" ? "firstTasks" : p.key}`)}
									title={t(`onboardingAgent:pitch.${p.key}`)}
								/>
							))}
						</div>
					</Column>
				</Columns>
				<Composer
					prompt={
						<span className="wp-muted truncate text-xs">
							{projectPath ?? t("onboardingAgent:errors.noProject")}
						</span>
					}
					hint={t("onboardingAgent:packageIntro")}
					actions={
						phase === "error" ? (
							<>
								<CharterButton icon={RotateCcw} onClick={reset}>
									{t("common:buttons.retry")}
								</CharterButton>
								{runButton}
							</>
						) : (
							!isScanning && runButton
						)
					}
				/>
			</ModuleStage>
		);
	}

	if (!pkg) return null;

	const allTabs: Array<{
		id: OnboardingAgentTab;
		icon: React.ReactNode;
		label: string;
		badge?: number;
	}> = [
		{
			id: "overview",
			icon: <LayoutDashboard className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.overview"),
		},
		{
			id: "story",
			icon: <BookOpenText className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.story"),
			badge: pkg.story?.hotspots.length,
		},
		{
			id: "tour",
			icon: <MapIcon className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.tour"),
			badge: pkg.tour.length,
		},
		{
			id: "architecture",
			icon: <FolderTree className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.architecture"),
			badge: pkg.guide.architecture?.length ?? 0,
		},
		{
			id: "quiz",
			icon: <MessageCircleQuestion className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.quiz"),
			badge: pkg.quiz.length,
		},
		{
			id: "tasks",
			icon: <ListChecks className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.firstTasks"),
			badge: pkg.first_tasks.length,
		},
		{
			id: "glossary",
			icon: <BookOpen className="h-3.5 w-3.5" />,
			label: t("onboardingAgent:tabs.glossary"),
			badge: pkg.glossary.length,
		},
	];
	// "I already know this project": no tour and no quiz, the map stays.
	const tabs = skipTour ? allTabs.filter((entry) => entry.id !== "tour" && entry.id !== "quiz") : allTabs;
	const shownTab: OnboardingAgentTab = skipTour && (tab === "tour" || tab === "quiz") ? "architecture" : tab;

	return (
		<ModuleStage data-testid="onboarding-package-view">
			<ModuleHeader
				kicker={t("onboardingAgent:kickers.package")}
				title={pkg.guide.project_name}
				icon={BookOpen}
				description={
					<Chips>
						{pkg.guide.tech_stack.slice(0, 6).map((tech) => (
							<Chip key={tech} tone="blue">
								{tech}
							</Chip>
						))}
						{pkg.guide.tech_stack.length > 6 && <Chip tone="muted">+{pkg.guide.tech_stack.length - 6}</Chip>}
					</Chips>
				}
				actions={
					<>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={skipTour ? MapIcon : EyeOff}
							aria-pressed={skipTour}
							onClick={() => setSkipTour(!skipTour)}
						>
							{skipTour ? t("onboardingAgent:actions.showTour") : t("onboardingAgent:actions.skipTour")}
						</CharterButton>
						<CharterButton size="sm" icon={Download} onClick={() => void exportTour("markdown")}>
							{t("onboardingAgent:actions.exportMarkdown")}
						</CharterButton>
						<CharterButton size="sm" icon={FileCode} onClick={() => void exportTour("html")}>
							{t("onboardingAgent:actions.exportHtml")}
						</CharterButton>
						<CharterButton
							size="sm"
							icon={RotateCcw}
							onClick={() => projectPath && startScan(projectPath)}
							disabled={!projectPath}
						>
							{t("onboardingAgent:actions.regenerate")}
						</CharterButton>
						<CharterButton size="sm" variant="ghost" onClick={reset}>
							{t("common:buttons.reset")}
						</CharterButton>
					</>
				}
			/>

			<div className="relative z-[1] flex gap-1.5 overflow-x-auto px-5 pt-3" role="tablist">
				{tabs.map((entry) => (
					<button
						type="button"
						role="tab"
						aria-selected={shownTab === entry.id}
						key={entry.id}
						onClick={() => setTab(entry.id)}
						className="wp-chip !gap-2 !px-3 !py-1"
						data-dot="false"
						style={shownTab === entry.id ? { color: "var(--wp-title)", borderColor: "var(--wp-accent)" } : undefined}
					>
						{entry.icon}
						<span>{entry.label}</span>
						{entry.badge !== undefined && <span className="wp-faint">{entry.badge}</span>}
					</button>
				))}
			</div>

			<div className="relative z-[1] min-h-0 flex-1 overflow-auto px-5 py-4">
				{isScanning && (
					<div className="mb-3">
						<ScanLine label={generated(statusI18n, status) || t("onboardingAgent:actions.scanning")} />
					</div>
				)}
				{phase === "error" && (
					<Notice tone="red" icon={TriangleAlert} role="alert" className="mb-3">
						{errorKey
							? t(`onboardingAgent:${errorKey}`)
							: t("onboardingAgent:errors.failed", { error: error ?? "" })}
					</Notice>
				)}
				{regenerated && (
					<Notice tone="blue" icon={History} role="status" className="mb-3">
						{t("onboardingAgent:freshness.regenerated", {
							added: regenerated.added.join(", ") || t("onboardingAgent:freshness.none"),
							removed: regenerated.removed.join(", ") || t("onboardingAgent:freshness.none"),
						})}
					</Notice>
				)}
				{skipTour && (
					<Notice tone="muted" icon={EyeOff} role="status" className="mb-3">
						{t("onboardingAgent:freshness.skipped")}
					</Notice>
				)}
				{exportNotice && (
					<Notice tone={exportNotice.tone} role={exportNotice.tone === "red" ? "alert" : "status"} className="mb-3">
						<span className="break-all">{exportNotice.text}</span>
					</Notice>
				)}
				{shownTab === "overview" && <OverviewPanel />}
				{shownTab === "story" && <StoryPanel projectPath={projectPath} />}
				{shownTab === "tour" && <TourPanel />}
				{shownTab === "architecture" && <ArchitecturePanel />}
				{shownTab === "quiz" && <QuizPanel />}
				{shownTab === "tasks" && <FirstTasksPanel />}
				{shownTab === "glossary" && <GlossaryPanel />}
			</div>
		</ModuleStage>
	);
}
