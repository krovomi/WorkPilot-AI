import { AppWindow, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpAppViewSummary, Task } from "../../../shared/types";
import { Badge } from "../ui/badge";
import { McpAppFrame } from "./McpAppFrame";

export interface McpAppsCardProps {
	readonly task: Task;
}

/**
 * Les vues MCP Apps d'une tâche, en une carte.
 *
 * Un serveur MCP installé peut attacher une vue à un outil : un tableau, une
 * carte, un graphique. Quand l'agent appelle cet outil pendant le build, la
 * vue est gardée avec la tâche ; la carte les liste, la plus récente d'abord,
 * et en ouvre une à la fois. La vue montre l'appel qui a eu lieu : elle ne
 * peut ni rappeler un outil, ni écrire à l'agent, ni ouvrir un lien.
 *
 * Elle ne s'affiche que quand une vue a été gardée.
 */
export function McpAppsCard({ task }: McpAppsCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [views, setViews] = useState<McpAppViewSummary[]>([]);
	const [openId, setOpenId] = useState<string | null>(null);
	const [hostVersion, setHostVersion] = useState("unknown");

	const load = useCallback(async () => {
		const api = globalThis.electronAPI;
		if (typeof api?.listMcpAppViews !== "function") return;
		try {
			const result = await api.listMcpAppViews(task.id);
			if (result.success && result.data) setViews(result.data);
		} catch {
			// Best-effort: the next view event reloads the list.
		}
	}, [task.id]);

	useEffect(() => {
		const api = globalThis.electronAPI;
		void load();
		if (typeof api?.getAppVersion === "function") {
			void api
				.getAppVersion()
				.then(setHostVersion)
				.catch(() => {
					/* the view is told "unknown" */
				});
		}
		const unsubscribe =
			typeof api?.onMcpAppView === "function"
				? api.onMcpAppView((taskId) => {
						if (taskId === task.id) void load();
					})
				: undefined;
		return () => unsubscribe?.();
	}, [load, task.id]);

	if (views.length === 0) return null;

	return (
		<div className="rounded-lg border border-border bg-card/60 p-3" data-testid="mcp-apps-card">
			<div className="flex items-center gap-2">
				<AppWindow className="h-4 w-4 shrink-0 text-primary" aria-hidden />
				<span className="text-sm font-medium">{t("tasks:mcpApps.title")}</span>
				<Badge variant="outline" className="text-[10px]">
					{t("tasks:mcpApps.count", { count: views.length })}
				</Badge>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{t("tasks:mcpApps.subtitle")}</p>
			<ul className="mt-3 space-y-2">
				{views.map((view) => {
					const isOpen = openId === view.viewId;
					return (
						<li key={view.viewId} className="space-y-2">
							<button
								type="button"
								onClick={() => setOpenId(isOpen ? null : view.viewId)}
								aria-expanded={isOpen}
								className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs hover:bg-muted"
							>
								{isOpen ? (
									<ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
								) : (
									<ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
								)}
								<span className="font-mono">
									{view.server} · {view.tool}
								</span>
								<span className="ml-auto text-muted-foreground">
									{new Date(view.createdAt * 1000).toLocaleString()}
								</span>
							</button>
							{isOpen && (
								<McpAppFrame taskId={task.id} viewId={view.viewId} hostVersion={hostVersion} />
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
