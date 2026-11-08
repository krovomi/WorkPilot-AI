import {
	BookOpen,
	FolderTree,
	LayoutDashboard,
	ListChecks,
	Map as MapIcon,
	MessageCircleQuestion,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
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
import { FirstTasksPanel } from "./FirstTasksPanel";
import { GlossaryPanel } from "./GlossaryPanel";
import { OverviewPanel } from "./OverviewPanel";
import { QuizPanel } from "./QuizPanel";
import { TourPanel } from "./TourPanel";

interface OnboardingPackageViewProps {
	readonly projectPath?: string;
}

export function OnboardingPackageView({
	projectPath,
}: OnboardingPackageViewProps): React.ReactElement | null {
	const { t } = useTranslation(["onboardingAgent", "common"]);

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

	const isScanning = phase === "scanning";

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

	const tabs: Array<{
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
						aria-selected={tab === entry.id}
						key={entry.id}
						onClick={() => setTab(entry.id)}
						className="wp-chip !gap-2 !px-3 !py-1"
						data-dot="false"
						style={tab === entry.id ? { color: "var(--wp-title)", borderColor: "var(--wp-accent)" } : undefined}
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
				{tab === "overview" && <OverviewPanel />}
				{tab === "tour" && <TourPanel />}
				{tab === "architecture" && <ArchitecturePanel />}
				{tab === "quiz" && <QuizPanel />}
				{tab === "tasks" && <FirstTasksPanel />}
				{tab === "glossary" && <GlossaryPanel />}
			</div>
		</ModuleStage>
	);
}
