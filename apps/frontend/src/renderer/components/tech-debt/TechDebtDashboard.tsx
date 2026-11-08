import { ArrowRight, FileWarning, Gauge, RefreshCw, TrendingDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DebtItem } from "../../../preload/api/modules/tech-debt-api";
import type { Lang } from "../../lib/debt-task-spec";
import { useProjectStore } from "../../stores/project-store";
import { useTechDebtStore } from "../../stores/tech-debt-store";
import {
	CharterButton,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
} from "../charter";
import { Input } from "../ui/input";
import { DebtHeatmap } from "./DebtHeatmap";
import { DebtItemsTable } from "./DebtItemsTable";
import { DebtTrendChart } from "./DebtTrendChart";
import { formatAppDateTime } from "@/lib/date-format";

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

	const lastScanned = lastScannedAt
		? t("techDebt:lastScanned", { when: formatAppDateTime(lastScannedAt * 1000) })
		: undefined;

	return (
		<ModuleStage data-testid="tech-debt-view">
			<Columns template="minmax(300px, 40%) minmax(0, 1fr)">
				<Column kicker={t("techDebt:kickers.overview")} title={t("techDebt:title")} meta={lastScanned}>
					<div className="flex flex-col gap-3">
						{scanning && <ScanLine label={t("techDebt:actions.scan")} />}
						{summary ? (
							<Stats>
								<Stat label={t("techDebt:summary.total")} value={summary.total} tone="orange" />
								<Stat label={t("techDebt:summary.totalCost")} value={summary.total_cost} />
								<Stat label={t("techDebt:summary.totalEffort")} value={summary.total_effort} />
								<Stat label={t("techDebt:summary.avgRoi")} value={summary.avg_roi} tone="green" />
							</Stats>
						) : (
							!scanning && (
								<EmptyStage icon={Gauge} title={t("techDebt:title")} tone="orange">
									{t("techDebt:description")}
								</EmptyStage>
							)
						)}
						<Panel>
							<span className="wp-kicker">{t("techDebt:sections.trend")}</span>
							<div className="mt-2">
								<DebtTrendChart trend={trend} />
							</div>
						</Panel>
						<Panel>
							<span className="wp-kicker">{t("techDebt:sections.heatmap")}</span>
							<div className="mt-2">
								<DebtHeatmap items={filteredItems} />
							</div>
						</Panel>
					</div>
				</Column>
				<Column
					kicker={t("techDebt:kickers.items")}
					title={t("techDebt:sections.top", { count: topItems.length })}
					tone="orange"
				>
					<div className="flex flex-col gap-3">
						{createdTask && (
							<Notice tone="green" icon={ArrowRight} role="status">
								<button
									type="button"
									onClick={openCreatedTaskInKanban}
									className="flex w-full items-center justify-between gap-2 text-left"
								>
									<span className="truncate">
										{t("techDebt:taskCreated", { title: createdTask.title })}
									</span>
									<span className="shrink-0 font-medium text-primary underline-offset-2 hover:underline">
										{t("techDebt:openInKanban")}
									</span>
								</button>
							</Notice>
						)}
						{topItems.length === 0 && !scanning ? (
							<EmptyStage icon={TrendingDown} title={t("techDebt:empty")} tone="orange" />
						) : (
							<DebtItemsTable
								items={topItems}
								onCreateTask={handleCreateTask}
								creatingItemId={creatingItemId}
							/>
						)}
					</div>
				</Column>
			</Columns>
			{error && (
				<Notice tone="red" icon={FileWarning} role="alert" className="relative z-[2] mx-5 mb-2">
					{error}
				</Notice>
			)}
			<Composer
				prompt={
					<Input
						id="td-project"
						aria-label={t("techDebt:fields.projectPath")}
						value={projectInput}
						onChange={(e) => setProjectInput(e.target.value)}
						placeholder="/abs/path/to/project"
						className="h-8 border-0 bg-transparent px-0 font-mono text-xs shadow-none focus-visible:ring-0"
					/>
				}
				options={
					<>
						<label className="wp-field" htmlFor="td-min">
							{t("techDebt:fields.minScore")}
							<input
								id="td-min"
								type="number"
								step={0.1}
								className="w-14 bg-transparent font-medium text-foreground outline-none"
								value={filters.minScore}
								onChange={(e) => setFilter("minScore", Number(e.target.value) || 0)}
							/>
						</label>
						<label className="wp-field min-w-0 flex-1" htmlFor="td-search">
							{t("techDebt:fields.search")}
							<input
								id="td-search"
								className="min-w-0 flex-1 bg-transparent font-medium text-foreground outline-none"
								value={filters.search}
								onChange={(e) => setFilter("search", e.target.value)}
								placeholder={t("techDebt:fields.searchPlaceholder")}
							/>
						</label>
					</>
				}
				actions={
					<CharterButton variant="primary" icon={RefreshCw} busy={scanning} onClick={handleScan} disabled={!canScan}>
						{t("techDebt:actions.scan")}
					</CharterButton>
				}
			/>
		</ModuleStage>
	);
}
