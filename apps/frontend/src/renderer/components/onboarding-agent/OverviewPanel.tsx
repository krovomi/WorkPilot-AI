import {
	BookOpen,
	FileCode,
	FolderTree,
	Languages,
	Rocket,
	ScrollText,
	Terminal,
	TestTube,
} from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingCommand } from "../../../preload/api/modules/onboarding-agent-api";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { Badge } from "../ui/badge";
import {
	CategoryBadge,
	CommandLine,
	EmptyState,
	SectionTitle,
	useGeneratedText,
} from "./shared";

const COMMAND_ORDER: OnboardingCommand["category"][] = [
	"setup",
	"run",
	"build",
	"test",
	"lint",
	"other",
];

const STAT_ICONS: Record<string, React.ReactNode> = {
	code_files: <FileCode className="w-4 h-4" />,
	test_files: <TestTube className="w-4 h-4" />,
	directories: <FolderTree className="w-4 h-4" />,
	languages: <Languages className="w-4 h-4" />,
};

function StatCard({
	statKey,
	value,
	label,
}: {
	readonly statKey: string;
	readonly value: number;
	readonly label: string;
}): React.ReactElement {
	return (
		<div className="border rounded-md p-3 bg-card">
			<div className="flex items-center gap-2 text-muted-foreground text-xs">
				{STAT_ICONS[statKey]}
				<span>{label}</span>
			</div>
			<p className="text-xl font-semibold mt-1">{value.toLocaleString()}</p>
		</div>
	);
}

export function OverviewPanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const setActiveTab = useOnboardingAgentStore((s) => s.setActiveTab);
	const generated = useGeneratedText();

	if (!pkg) return null;

	const guide = pkg.guide;
	const stats = guide.stats ?? {};
	const gettingStarted = guide.section_lines?.getting_started ?? [];
	const commandsByCategory = COMMAND_ORDER.map((category) => ({
		category,
		commands: (guide.commands ?? []).filter((c) => c.category === category),
	})).filter((group) => group.commands.length > 0);

	const copy = (command: string): void => {
		void navigator.clipboard?.writeText(command);
	};

	return (
		<div className="space-y-6">
			<section>
				<SectionTitle icon={<Rocket className="w-4 h-4" />}>
					{t("overview.stack")}
				</SectionTitle>
				{guide.tech_stack.length > 0 ? (
					<div className="flex flex-wrap gap-1.5">
						{guide.tech_stack.map((tech) => (
							<Badge key={tech} variant="info">
								{tech}
							</Badge>
						))}
					</div>
				) : (
					<EmptyState message={t("overview.noStack")} />
				)}
			</section>

			{Object.keys(stats).length > 0 && (
				<section className="grid grid-cols-2 md:grid-cols-4 gap-2">
					{(
						["code_files", "test_files", "directories", "languages"] as const
					).map((key) =>
						typeof stats[key] === "number" ? (
							<StatCard
								key={key}
								statKey={key}
								value={stats[key] as number}
								label={t(`overview.stats.${key}`)}
							/>
						) : null,
					)}
				</section>
			)}

			{gettingStarted.length > 0 && (
				<section>
					<SectionTitle icon={<Terminal className="w-4 h-4" />}>
						{t("overview.gettingStarted")}
					</SectionTitle>
					<ol className="border rounded-md p-3 bg-card space-y-1 list-decimal list-inside text-sm">
						{gettingStarted.map((line) => (
							<li key={`${line.key}:${line.fallback}`}>
								{generated(line)}
							</li>
						))}
					</ol>
				</section>
			)}

			{commandsByCategory.length > 0 && (
				<section>
					<SectionTitle icon={<Terminal className="w-4 h-4" />}>
						{t("overview.commands")}
					</SectionTitle>
					<div className="space-y-3">
						{commandsByCategory.map((group) => (
							<div key={group.category}>
								<div className="mb-1">
									<CategoryBadge
										category={group.category}
										label={t(`commandCategories.${group.category}`)}
									/>
								</div>
								<div className="space-y-1">
									{group.commands.map((command) => (
										<div key={command.command}>
											<CommandLine
												command={command.command}
												copyLabel={t("actions.copy")}
												onCopy={copy}
											/>
											<p className="text-xs text-muted-foreground mt-0.5 pl-3">
												{generated(command.label_i18n, command.label)}
												{command.source ? ` — ${command.source}` : ""}
											</p>
										</div>
									))}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			{guide.entry_points?.length > 0 && (
				<section>
					<SectionTitle icon={<Rocket className="w-4 h-4" />}>
						{t("overview.entryPoints")}
					</SectionTitle>
					<ul className="space-y-1">
						{guide.entry_points.map((entry) => (
							<li key={entry.path} className="border rounded-md p-2 bg-card">
								<p className="text-sm font-mono">{entry.path}</p>
								<p className="text-xs text-muted-foreground">
									{generated(entry.reason_i18n, entry.reason)}
								</p>
							</li>
						))}
					</ul>
				</section>
			)}

			{guide.conventions?.length > 0 && (
				<section>
					<SectionTitle icon={<ScrollText className="w-4 h-4" />}>
						{t("overview.conventions")}
					</SectionTitle>
					<ul className="space-y-1">
						{guide.conventions.map((convention) => (
							<li
								key={convention.name}
								className="border rounded-md p-2 bg-card"
							>
								<p className="text-sm font-medium">
									{generated(convention.name_i18n, convention.name)}
								</p>
								<p className="text-xs text-muted-foreground">
									{generated(
										convention.description_i18n,
										convention.description,
									)}
								</p>
								{convention.examples?.length > 0 && (
									<p className="text-xs font-mono text-muted-foreground mt-1 truncate">
										{convention.examples.join(" · ")}
									</p>
								)}
							</li>
						))}
					</ul>
				</section>
			)}

			{guide.key_files?.length > 0 && (
				<section>
					<SectionTitle
						icon={<BookOpen className="w-4 h-4" />}
						action={
							<button
								type="button"
								onClick={() => setActiveTab("tour")}
								className="text-xs text-primary hover:underline"
							>
								{t("overview.startTour")}
							</button>
						}
					>
						{t("overview.keyFiles")}
					</SectionTitle>
					<ul className="space-y-1">
						{guide.key_files.slice(0, 12).map((file) => (
							<li
								key={file.path}
								className="border rounded-md p-2 bg-card flex items-start justify-between gap-3"
							>
								<div className="min-w-0">
									<p className="text-sm font-mono truncate">{file.path}</p>
									<p className="text-xs text-muted-foreground">
										{generated(file.reason_i18n, file.reason)}
									</p>
								</div>
								{file.lines > 0 && (
									<span className="text-xs text-muted-foreground whitespace-nowrap">
										{t("overview.lines", { count: file.lines })}
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
