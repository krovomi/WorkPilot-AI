import {
	BookOpen,
	FolderTree,
	LayoutDashboard,
	ListChecks,
	Map as MapIcon,
	MessageCircleQuestion,
	RotateCcw,
} from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingAgentTab } from "../../stores/onboarding-agent-store";
import {
	setupOnboardingAgentListeners,
	useOnboardingAgentStore,
} from "../../stores/onboarding-agent-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
	const error = useOnboardingAgentStore((s) => s.error);
	const tab = useOnboardingAgentStore((s) => s.activeTab);
	const setTab = useOnboardingAgentStore((s) => s.setActiveTab);
	const startScan = useOnboardingAgentStore((s) => s.startScan);
	const reset = useOnboardingAgentStore((s) => s.reset);

	useEffect(() => {
		const cleanup = setupOnboardingAgentListeners();
		return cleanup;
	}, []);

	const isScanning = phase === "scanning";

	if (!pkg && !isScanning && phase !== "error") {
		return (
			<div className="p-6 space-y-3 max-w-2xl">
				<h2 className="text-lg font-semibold flex items-center gap-2">
					<BookOpen className="w-5 h-5" />
					{t("onboardingAgent:packageTitle")}
				</h2>
				<p className="text-sm text-muted-foreground">
					{t("onboardingAgent:packageIntro")}
				</p>
				<ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
					<li>{t("onboardingAgent:pitch.overview")}</li>
					<li>{t("onboardingAgent:pitch.tour")}</li>
					<li>{t("onboardingAgent:pitch.quiz")}</li>
					<li>{t("onboardingAgent:pitch.tasks")}</li>
					<li>{t("onboardingAgent:pitch.glossary")}</li>
				</ul>
				<Button
					onClick={() => projectPath && startScan(projectPath)}
					disabled={!projectPath}
				>
					{t("onboardingAgent:actions.runScan")}
				</Button>
				{!projectPath && (
					<p className="text-sm text-muted-foreground">
						{t("onboardingAgent:errors.noProject")}
					</p>
				)}
			</div>
		);
	}

	if (isScanning) {
		return (
			<div className="p-6">
				<p className="text-sm text-muted-foreground">
					{status || t("onboardingAgent:actions.scanning")}
				</p>
			</div>
		);
	}

	if (phase === "error") {
		return (
			<div className="p-6 space-y-3">
				<p className="text-sm text-destructive">
					{t("onboardingAgent:errors.failed", { error: error ?? "" })}
				</p>
				<Button variant="outline" onClick={reset}>
					{t("common:buttons.retry")}
				</Button>
			</div>
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
			icon: <LayoutDashboard className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.overview"),
		},
		{
			id: "tour",
			icon: <MapIcon className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.tour"),
			badge: pkg.tour.length,
		},
		{
			id: "architecture",
			icon: <FolderTree className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.architecture"),
			badge: pkg.guide.architecture?.length ?? 0,
		},
		{
			id: "quiz",
			icon: <MessageCircleQuestion className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.quiz"),
			badge: pkg.quiz.length,
		},
		{
			id: "tasks",
			icon: <ListChecks className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.firstTasks"),
			badge: pkg.first_tasks.length,
		},
		{
			id: "glossary",
			icon: <BookOpen className="w-4 h-4" />,
			label: t("onboardingAgent:tabs.glossary"),
			badge: pkg.glossary.length,
		},
	];

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-start justify-between gap-4 p-4 border-b">
				<div className="min-w-0">
					<h2 className="text-lg font-semibold flex items-center gap-2">
						<BookOpen className="w-5 h-5" />
						{pkg.guide.project_name}
					</h2>
					<div className="flex flex-wrap items-center gap-1.5 mt-1">
						{pkg.guide.tech_stack.slice(0, 6).map((tech) => (
							<Badge key={tech} variant="info">
								{tech}
							</Badge>
						))}
						{pkg.guide.tech_stack.length > 6 && (
							<Badge variant="muted">
								+{pkg.guide.tech_stack.length - 6}
							</Badge>
						)}
					</div>
				</div>
				<div className="flex gap-2 shrink-0">
					<Button
						variant="outline"
						size="sm"
						onClick={() => projectPath && startScan(projectPath)}
						disabled={!projectPath}
					>
						<RotateCcw className="w-4 h-4 mr-1" />
						{t("onboardingAgent:actions.regenerate")}
					</Button>
					<Button variant="outline" size="sm" onClick={reset}>
						{t("common:buttons.reset")}
					</Button>
				</div>
			</div>

			<div className="flex border-b text-sm overflow-x-auto">
				{tabs.map((entry) => (
					<button
						type="button"
						key={entry.id}
						onClick={() => setTab(entry.id)}
						className={`flex items-center gap-2 px-4 py-2 border-b-2 whitespace-nowrap ${
							tab === entry.id
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{entry.icon}
						<span>{entry.label}</span>
						{entry.badge !== undefined && (
							<span className="text-xs bg-muted px-1.5 rounded">
								{entry.badge}
							</span>
						)}
					</button>
				))}
			</div>

			<div className="flex-1 overflow-auto p-4">
				{tab === "overview" && <OverviewPanel />}
				{tab === "tour" && <TourPanel />}
				{tab === "architecture" && <ArchitecturePanel />}
				{tab === "quiz" && <QuizPanel />}
				{tab === "tasks" && <FirstTasksPanel />}
				{tab === "glossary" && <GlossaryPanel />}
			</div>
		</div>
	);
}
