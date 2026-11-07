import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSharedAnalysisReport } from "../../hooks/useSharedAnalysisReport";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { formatAppDateTime } from "@/lib/date-format";

/** The changelog a member of a server project last built, as the server saved it. */
interface SharedChangelog {
	changelog?: unknown;
	version?: unknown;
}

const NO_APPLY = () => undefined;

/** The selected project, when it is a server project (server mode). */
export function useServerChangelogProject() {
	return useProjectStore((state) =>
		state.projects.find((p) => p.id === state.selectedProjectId && p.remote),
	);
}

/**
 * The last changelog shared on the server for a server project, which every
 * member reads: when it was built, its version, and a way to open it. Nothing
 * for a local project, which keeps none.
 */
export function SharedChangelogNote({
	isGenerating,
	onOpen,
}: {
	readonly isGenerating: boolean;
	readonly onOpen: (changelog: string, version: string) => void;
}): React.ReactElement | null {
	const { t } = useTranslation("changelog");
	const project = useServerChangelogProject();
	const saved = useSharedAnalysisReport<SharedChangelog>(
		"changelog",
		project?.path,
		NO_APPLY,
		isGenerating,
	);
	const report = (saved?.report ?? {}) as SharedChangelog;
	const changelog = typeof report.changelog === "string" ? report.changelog : "";
	if (!project || !changelog) return null;
	const version = typeof report.version === "string" ? report.version : "";
	const date = saved?.finishedAt ? new Date(saved.finishedAt) : null;
	return (
		<div className="flex items-center justify-between gap-4 border-b border-border bg-muted/30 px-6 py-3">
			<p className="flex items-center gap-2 text-sm text-muted-foreground">
				<FileText className="h-4 w-4 shrink-0" />
				{t("server.lastShared", {
					version,
					date: date && !Number.isNaN(date.getTime()) ? formatAppDateTime(date) : "",
				})}
			</p>
			<Button
				variant="outline"
				size="sm"
				onClick={() => onOpen(changelog, version)}
				disabled={isGenerating}
			>
				{t("server.open")}
			</Button>
		</div>
	);
}
