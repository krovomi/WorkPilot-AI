import { FolderPlus } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMultiRepoStore } from "@/stores/multi-repo-store";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * RepoSelector - the repositories of a multi-repo task: projects of this
 * computer, or a folder picked in the system dialog (it becomes a project).
 * Paths never come from typing: the main process only accepts those two.
 */
export function RepoSelector() {
	const { t } = useTranslation(["multiRepo"]);
	const projects = useProjectStore((s) => s.projects);
	const pickedRepos = useMultiRepoStore((s) => s.pickedRepos);
	const toggleRepo = useMultiRepoStore((s) => s.toggleRepo);

	const localProjects = useMemo(() => projects.filter((p) => !p.remote), [projects]);
	const extraFolders = pickedRepos.filter((r) => !localProjects.some((p) => p.path === r.path));
	const isPicked = (path: string) => pickedRepos.some((r) => r.path === path);

	const handleBrowse = async () => {
		const chosen = await window.electronAPI.selectDirectory();
		if (!chosen || isPicked(chosen)) return;
		toggleRepo({ path: chosen, name: chosen.split(/[\\/]/).filter(Boolean).pop() ?? chosen });
	};

	const rows = [
		...localProjects.map((p) => ({ path: p.path, name: p.name })),
		...extraFolders,
	];

	return (
		<div className="space-y-3">
			<ul className="max-h-64 space-y-1.5 overflow-y-auto">
				{rows.map((row) => {
					const picked = isPicked(row.path);
					const order = pickedRepos.findIndex((r) => r.path === row.path) + 1;
					return (
						<li key={row.path}>
							<label
								className={cn(
									"flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors",
									picked ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/40",
								)}
							>
								<input
									type="checkbox"
									className="h-4 w-4 accent-primary"
									checked={picked}
									onChange={() => toggleRepo(row)}
								/>
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium text-foreground">{row.name}</div>
									<div className="truncate text-xs text-muted-foreground">{row.path}</div>
								</div>
								{picked && (
									<span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
										{order}
									</span>
								)}
							</label>
						</li>
					);
				})}
			</ul>
			{rows.length === 0 && (
				<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
					{t("multiRepo:dialog.noProjects")}
				</p>
			)}
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					{t("multiRepo:dialog.pickedCount", { count: pickedRepos.length })}
				</p>
				<Button type="button" variant="outline" size="sm" onClick={handleBrowse}>
					<FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" />
					{t("multiRepo:dialog.addFolder")}
				</Button>
			</div>
		</div>
	);
}
