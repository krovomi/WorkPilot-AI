import {
	AlertTriangle,
	Check,
	Copy,
	FolderSearch,
	TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Project,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface RepositorySectionProps {
	readonly project: Project;
	readonly settings: ProjectSettingsType;
}

/**
 * Where this project actually lives on disk, and the repository facts that go
 * with it. Rendered before the WorkPilot AI integration block and *outside* its
 * initialization gate: the checkout path is what someone opening a project's
 * settings looks for first, and it is knowable — and worth re-pointing — long
 * before `.workpilot/` exists.
 */
export function RepositorySection({
	project,
	settings,
}: RepositorySectionProps) {
	const { t } = useTranslation(["settings", "common"]);
	const missingPaths = useProjectStore((state) => state.missingPaths);
	const repathProject = useProjectStore((state) => state.repathProject);
	const isMissing = missingPaths.has(project.id);

	const handleRepath = async () => {
		try {
			const newPath = await globalThis.electronAPI?.selectDirectory?.();
			if (!newPath) return;
			await repathProject(project.id, newPath);
		} catch (err) {
			console.error("[RepositorySection] repath failed:", err);
		}
	};

	const handleOpenTerminal = async () => {
		try {
			await globalThis.electronAPI?.openTerminal?.(project.path);
		} catch (err) {
			console.error("[RepositorySection] open terminal failed:", err);
		}
	};

	return (
		<section className="space-y-4">
			<h3 className="text-sm font-semibold text-foreground">
				{t("projectSections.repository.title")}
			</h3>

			<div className="rounded-lg border border-border bg-muted/30 divide-y divide-border">
				<Row label={t("projectSections.repository.name")}>
					<span className="text-sm text-foreground">{project.name}</span>
				</Row>

				<Row label={t("projectSections.repository.path")}>
					<div className="space-y-2">
						<PathValue value={project.path} invalid={isMissing} />
						<div className="flex flex-wrap items-center gap-1">
							<CopyButton
								value={project.path}
								label={t("projectSections.repository.copyPath")}
							/>
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 gap-1.5 px-2 text-xs"
										onClick={handleOpenTerminal}
										disabled={isMissing}
									>
										<TerminalSquare className="h-3.5 w-3.5" />
										{t("projectSections.repository.openTerminal")}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("projectSections.repository.openTerminalHint")}
								</TooltipContent>
							</Tooltip>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1.5 px-2 text-xs"
								onClick={handleRepath}
							>
								<FolderSearch className="h-3.5 w-3.5" />
								{t("projectSections.repository.changeFolder")}
							</Button>
						</div>
						{isMissing && (
							<p className="flex items-start gap-1.5 text-xs text-destructive">
								<AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden />
								{t("common:projectTab.missingPathDescription")}
							</p>
						)}
					</div>
				</Row>

				<Row label={t("projectSections.repository.workpilotPath")}>
					{project.autoBuildPath ? (
						<div className="space-y-2">
							<PathValue value={project.autoBuildPath} />
							<CopyButton
								value={project.autoBuildPath}
								label={t("projectSections.repository.copyPath")}
							/>
						</div>
					) : (
						<span className="text-sm text-muted-foreground">
							{t("projectSections.repository.workpilotPathMissing")}
						</span>
					)}
				</Row>

				<Row label={t("projectSections.repository.mainBranch")}>
					{settings.mainBranch ? (
						<code className="text-xs bg-background px-2 py-1 rounded border border-border">
							{settings.mainBranch}
						</code>
					) : (
						<span className="text-sm text-muted-foreground">
							{t("projectSections.repository.mainBranchAuto")}
						</span>
					)}
				</Row>
			</div>
		</section>
	);
}

function Row({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-3 sm:flex-row sm:items-start sm:gap-4">
			<span className="text-xs font-medium text-muted-foreground sm:w-40 sm:shrink-0 sm:pt-1">
				{label}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

function PathValue({
	value,
	invalid = false,
}: {
	readonly value: string;
	readonly invalid?: boolean;
}) {
	return (
		<code
			className={cn(
				"block text-xs bg-background px-2 py-1.5 rounded border border-border",
				"break-all font-mono",
				invalid && "border-destructive/50 text-destructive",
			)}
		>
			{value}
		</code>
	);
}

function CopyButton({
	value,
	label,
}: {
	readonly value: string;
	readonly label: string;
}) {
	const { t } = useTranslation("settings");
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch (err) {
			// Clipboard access can be denied; leave the button silent rather than
			// claiming a copy that did not happen.
			console.error("[RepositorySection] copy failed:", err);
		}
	};

	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1.5 px-2 text-xs"
			onClick={handleCopy}
			aria-label={label}
		>
			{copied ? (
				<>
					<Check className="h-3.5 w-3.5 text-success" />
					{t("projectSections.repository.copied")}
				</>
			) : (
				<>
					<Copy className="h-3.5 w-3.5" />
					{label}
				</>
			)}
		</Button>
	);
}
