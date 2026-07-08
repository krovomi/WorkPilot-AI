import { ArrowRight, FileWarning, Gauge, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DebtItem } from "../../../preload/api/modules/tech-debt-api";
import type { Lang } from "../../lib/debt-task-spec";
import { useProjectStore } from "../../stores/project-store";
import { useTechDebtStore } from "../../stores/tech-debt-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { DebtHeatmap } from "./DebtHeatmap";
import { DebtItemsTable } from "./DebtItemsTable";
import { DebtTrendChart } from "./DebtTrendChart";

interface Props {
	readonly projectPath?: string;
}

export function TechDebtDashboard({ projectPath }: Props) {
	const { t, i18n } = useTranslation(["techDebt", "common"]);
	const lang: Lang = i18n.language?.toLowerCase().startsWith("fr")
		? "fr"
		: "en";
	const {
		items,
		trend,
		summary,
		filters,
		scanning,
		error,
		lastScannedAt,
		setFilter,
		scan,
		refresh,
		createTaskFromItem,
	} = useTechDebtStore();

	const [projectInput, setProjectInput] = useState(projectPath ?? "");
	const [creatingItemId, setCreatingItemId] = useState<string | null>(null);
	const [createdTask, setCreatedTask] = useState<{
		id: string;
		title: string;
	} | null>(null);

	// On arrival, load any previously persisted debt items (fast, read-only).
	// A full scan is expensive and is only triggered when the user clicks the
	// button — auto-scanning here would keep the button disabled the whole time.
	useEffect(() => {
		if (projectPath && !items.length && !scanning) {
			void refresh(projectPath);
		}
	}, [projectPath, items.length, scanning, refresh]);

	const filteredItems = useMemo(() => {
		return items.filter((item) => {
			if (item.roi < filters.minScore) return false;
			if (filters.kind && item.kind !== filters.kind) return false;
			if (
				filters.search &&
				!`${item.file_path} ${item.message}`
					.toLowerCase()
					.includes(filters.search.toLowerCase())
			)
				return false;
			return true;
		});
	}, [items, filters]);

	const topItems = useMemo(
		() => [...filteredItems].sort((a, b) => b.roi - a.roi).slice(0, 10),
		[filteredItems],
	);

	const canScan = !scanning && !!projectInput.trim();

	const handleScan = () => {
		if (canScan) void scan(projectInput.trim());
	};

	// Resolve the target project id: the dashboard is fed a raw path, but tasks
	// are keyed by project id. Match the registered project by path, and fall
	// back to the active project.
	const resolveProjectId = (): string | null => {
		const projState = useProjectStore.getState();
		const target = projectInput.trim();
		const byPath = projState.projects.find((p) => p.path === target);
		return byPath?.id ?? projState.activeProjectId ?? null;
	};

	const handleCreateTask = async (item: DebtItem) => {
		if (!projectInput.trim() || creatingItemId) return;
		const projectId = resolveProjectId();
		if (!projectId) return;
		setCreatingItemId(item.id);
		try {
			const task = await createTaskFromItem(projectId, item, lang);
			if (task) setCreatedTask({ id: task.id, title: task.title });
		} finally {
			setCreatingItemId(null);
		}
	};

	const openCreatedTaskInKanban = () => {
		if (!createdTask) return;
		globalThis.dispatchEvent(
			new CustomEvent("workpilot:navigate-view", {
				detail: { view: "kanban", taskId: createdTask.id },
			}),
		);
	};

	return (
		<div className="p-6 space-y-6">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold flex items-center gap-2">
						<Gauge className="h-6 w-6" />
						{t("techDebt:title")}
					</h1>
					<p className="text-sm text-muted-foreground">
						{t("techDebt:description")}
					</p>
				</div>
				<Button onClick={handleScan} disabled={!canScan}>
					<RefreshCw
						className={`h-4 w-4 mr-2 ${scanning ? "animate-spin" : ""}`}
					/>
					{t("techDebt:actions.scan")}
				</Button>
			</header>

			<section className="grid grid-cols-1 md:grid-cols-3 gap-3">
				<div>
					<Label htmlFor="td-project">{t("techDebt:fields.projectPath")}</Label>
					<Input
						id="td-project"
						value={projectInput}
						onChange={(e) => setProjectInput(e.target.value)}
						placeholder="/abs/path/to/project"
					/>
				</div>
				<div>
					<Label htmlFor="td-min">{t("techDebt:fields.minScore")}</Label>
					<Input
						id="td-min"
						type="number"
						step={0.1}
						value={filters.minScore}
						onChange={(e) =>
							setFilter("minScore", Number(e.target.value) || 0)
						}
					/>
				</div>
				<div>
					<Label htmlFor="td-search">{t("techDebt:fields.search")}</Label>
					<Input
						id="td-search"
						value={filters.search}
						onChange={(e) => setFilter("search", e.target.value)}
						placeholder={t("techDebt:fields.searchPlaceholder")}
					/>
				</div>
			</section>

			{error && (
				<div className="p-3 rounded-md border border-destructive/40 bg-destructive/10 text-sm flex items-center gap-2">
					<FileWarning className="h-4 w-4" />
					{error}
				</div>
			)}

			{summary && (
				<section className="grid grid-cols-2 md:grid-cols-4 gap-3">
					<SummaryCard
						label={t("techDebt:summary.total")}
						value={String(summary.total)}
					/>
					<SummaryCard
						label={t("techDebt:summary.totalCost")}
						value={String(summary.total_cost)}
					/>
					<SummaryCard
						label={t("techDebt:summary.totalEffort")}
						value={String(summary.total_effort)}
					/>
					<SummaryCard
						label={t("techDebt:summary.avgRoi")}
						value={String(summary.avg_roi)}
					/>
				</section>
			)}

			<section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<div className="border rounded-md p-4">
					<h2 className="text-sm font-medium mb-3">
						{t("techDebt:sections.trend")}
					</h2>
					<DebtTrendChart trend={trend} />
				</div>
				<div className="border rounded-md p-4">
					<h2 className="text-sm font-medium mb-3">
						{t("techDebt:sections.heatmap")}
					</h2>
					<DebtHeatmap items={filteredItems} />
				</div>
			</section>

			<section className="border rounded-md p-4">
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-sm font-medium">
						{t("techDebt:sections.top", { count: topItems.length })}
					</h2>
					{lastScannedAt && (
						<span className="text-xs text-muted-foreground">
							{t("techDebt:lastScanned", {
								when: new Date(lastScannedAt * 1000).toLocaleString(),
							})}
						</span>
					)}
				</div>
				<DebtItemsTable
					items={topItems}
					onCreateTask={handleCreateTask}
					creatingItemId={creatingItemId}
				/>
			</section>

			{createdTask && (
				<button
					type="button"
					onClick={openCreatedTaskInKanban}
					className="w-full text-left p-3 rounded-md border bg-muted/40 hover:bg-muted/70 transition-colors text-sm flex items-center justify-between gap-2 group"
				>
					<span className="flex items-center gap-2 min-w-0">
						<ArrowRight className="h-4 w-4 shrink-0" />
						<span className="truncate">
							{t("techDebt:taskCreated", { title: createdTask.title })}
						</span>
					</span>
					<span className="shrink-0 text-xs font-medium text-primary group-hover:underline">
						{t("techDebt:openInKanban")}
					</span>
				</button>
			)}
		</div>
	);
}

function SummaryCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="border rounded-md p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="text-lg font-semibold">{value}</div>
		</div>
	);
}
