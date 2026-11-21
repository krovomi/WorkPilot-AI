import {
	ChevronDown,
	ChevronsUpDown,
	ChevronUp,
	Database,
	Download,
	FlaskConical,
	HardDriveDownload,
	Info,
	Loader2,
	RotateCw,
	Search,
	Sparkles,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
	type Formula,
	formulaKey,
	paretoFront,
	pickSmart,
	rankFormulas,
	useFormulaMatrixStore,
} from "../../stores/formula-matrix-store";
import { useToast } from "../../hooks/use-toast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { EfficiencyFrontier } from "./EfficiencyFrontier";
import { FormulaCard } from "./FormulaCard";
import {
	EFFORT_ORDER,
	effortLabel,
	formatCostBand,
	formatTokens,
	providerColor,
	providerName,
	shortModel,
	totalTokens,
} from "./formula-utils";
import { SuccessRing } from "./SuccessRing";

import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
// Generous cap: the full catalog is ~275 formulas, all renderable in the
// scrollable table. The "+N more" hint only triggers for pathological sets.
const MAX_ROWS = 500;

/** Sortable table columns; `null` falls back to the preference ranking. */
type SortKey = "formula" | "effort" | "tokens" | "cost" | "success" | null;

/** Ascending order of each sortable column. */
const COMPARE: Record<NonNullable<SortKey>, (a: Formula, b: Formula) => number> = {
	formula: (a, b) =>
		`${a.provider} ${a.model}`.localeCompare(`${b.provider} ${b.model}`),
	effort: (a, b) =>
		EFFORT_ORDER.indexOf(a.effort as (typeof EFFORT_ORDER)[number]) -
		EFFORT_ORDER.indexOf(b.effort as (typeof EFFORT_ORDER)[number]),
	tokens: (a, b) => totalTokens(a) - totalTokens(b),
	cost: (a, b) => a.expected_cost_usd - b.expected_cost_usd,
	success: (a, b) => a.success_probability - b.success_probability,
};

/** The four headline picks, in display order. */
const PICKS = [
	{ id: "bestValue", icon: "🏆", accent: "#16a34a" },
	{ id: "safest", icon: "🛡️", accent: "#0ea5e9" },
	{ id: "cheapest", icon: "💸", accent: "#f59e0b" },
	{ id: "fastest", icon: "⚡", accent: "#8b5cf6" },
] as const;

export function FormulaLab() {
	const { t } = useTranslation(["formulaLab", "common"]);
	const { toast } = useToast();
	const perTokenId = useId();
	const {
		isOpen,
		ticketTitle,
		matrix,
		loading,
		error,
		weight,
		selectedKey,
		appliedKey,
		applying,
		refining,
		refineError,
		setWeight,
		setSelectedKey,
		closeLab,
		fetchMatrix,
		applyFormula,
		refineTopFormulas,
	} = useFormulaMatrixStore(
		useShallow((s) => ({
			isOpen: s.isOpen,
			ticketTitle: s.ticketTitle,
			matrix: s.matrix,
			loading: s.loading,
			error: s.error,
			weight: s.weight,
			selectedKey: s.selectedKey,
			appliedKey: s.appliedKey,
			applying: s.applying,
			refining: s.refining,
			refineError: s.refineError,
			setWeight: s.setWeight,
			setSelectedKey: s.setSelectedKey,
			closeLab: s.closeLab,
			fetchMatrix: s.fetchMatrix,
			applyFormula: s.applyFormula,
			refineTopFormulas: s.refineTopFormulas,
		})),
	);

	const [providerFilter, setProviderFilter] = useState<string>("all");
	const [effortFilter, setEffortFilter] = useState<Set<string>>(
		() => new Set(EFFORT_ORDER),
	);
	const [perTokenOnly, setPerTokenOnly] = useState(false);
	const [search, setSearch] = useState("");
	// Column sort. `null` keeps the preference-based ranking (the slider order).
	const [sortKey, setSortKey] = useState<SortKey>(null);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

	const toggleSort = (key: NonNullable<SortKey>) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			// Costs read best cheapest-first; success/tokens best highest-first.
			setSortDir(key === "success" ? "desc" : "asc");
		}
	};

	const allFormulas = matrix?.formulas ?? [];

	const providers = useMemo(
		() =>
			Array.from(new Set(allFormulas.map((f) => f.provider))).sort((a, b) =>
				providerName(a).localeCompare(providerName(b)),
			),
		[allFormulas],
	);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return allFormulas.filter(
			(f) =>
				(providerFilter === "all" || f.provider === providerFilter) &&
				effortFilter.has(f.effort) &&
				(!perTokenOnly || f.per_token_billed) &&
				(!q ||
					f.model.toLowerCase().includes(q) ||
					providerName(f.provider).toLowerCase().includes(q)),
		);
	}, [allFormulas, providerFilter, effortFilter, perTokenOnly, search]);

	const ranked = useMemo(() => {
		if (!sortKey) return rankFormulas(filtered, weight);
		const dir = sortDir === "asc" ? 1 : -1;
		const compare = COMPARE[sortKey];
		return [...filtered].sort((a, b) => dir * compare(a, b));
	}, [filtered, weight, sortKey, sortDir]);
	const picks = useMemo(() => pickSmart(filtered), [filtered]);
	const pareto = useMemo(() => paretoFront(filtered), [filtered]);

	const selectedFormula =
		ranked.find((f) => formulaKey(f) === selectedKey) ?? null;

	const sortHeader = (
		key: NonNullable<SortKey>,
		labelKey: string,
		align: "left" | "right" | "center" = "left",
	) => {
		const alignCls =
			align === "right"
				? "text-right"
				: align === "center"
					? "text-center"
					: "";
		const justifyCls =
			align === "right"
				? "justify-end"
				: align === "center"
					? "justify-center"
					: "";
		const Icon =
			sortKey === key
				? sortDir === "asc"
					? ChevronUp
					: ChevronDown
				: ChevronsUpDown;
		const ariaSort =
			sortKey !== key
				? undefined
				: sortDir === "asc"
					? "ascending"
					: "descending";
		return (
			<th
				className={`select-none p-2 font-medium ${alignCls}`}
				aria-sort={ariaSort}
			>
				<button
					type="button"
					onClick={() => toggleSort(key)}
					className={`inline-flex cursor-pointer items-center gap-1 hover:text-foreground ${justifyCls}`}
				>
					{t(labelKey)}
					<Icon
						className={`h-3 w-3 ${sortKey === key ? "text-primary" : "opacity-40"}`}
					/>
				</button>
			</th>
		);
	};

	const toggleEffort = (effort: string) => {
		setEffortFilter((prev) => {
			const next = new Set(prev);
			if (next.has(effort)) {
				if (next.size > 1) next.delete(effort);
			} else {
				next.add(effort);
			}
			return next;
		});
	};

	const handleApply = async (formula: Formula) => {
		const ok = await applyFormula(formula);
		toast({
			title: ok
				? t("formulaLab:toast.appliedTitle")
				: t("formulaLab:toast.failedTitle"),
			description: ok
				? t("formulaLab:toast.appliedDesc", {
						model: shortModel(formula.model),
						effort: effortLabel(formula.effort, t),
					})
				: t("formulaLab:toast.failedDesc"),
			variant: ok ? "default" : "destructive",
		});
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && closeLab()}>
			<DialogContent className="flex max-h-[92vh] flex-col sm:max-w-[920px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Sparkles className="h-5 w-5 text-primary" />
						{t("formulaLab:title")}
						<span className="truncate text-sm font-normal text-muted-foreground">
							· {ticketTitle}
						</span>
					</DialogTitle>
					<DialogDescription>{t("formulaLab:subtitle")}</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
						<Loader2 className="mr-2 h-5 w-5 animate-spin" />
						{t("formulaLab:computing")}
					</div>
				)}

				{error && !loading && (
					<div className="space-y-3 rounded-md bg-destructive/10 p-4 text-sm text-destructive">
						<p>{t("formulaLab:error", { error })}</p>
						<Button variant="outline" size="sm" onClick={() => fetchMatrix()}>
							<RotateCw className="mr-1.5 h-4 w-4" />
							{t("formulaLab:retry")}
						</Button>
					</div>
				)}

				{matrix && !loading && !error && (
					<div className="flex-1 min-h-0 overflow-y-auto pr-2">
						<div className="space-y-4">
							{/* Preference slider + AI refine */}
							<div className="rounded-xl border bg-card/40 p-3">
								<div className="mb-2 flex items-center gap-3">
									<div className="flex flex-1 items-center justify-between text-xs font-medium">
										<span>💸 {t("formulaLab:slider.cost")}</span>
										<span className="text-muted-foreground">
											{t("formulaLab:slider.preference")}
										</span>
										<span>{t("formulaLab:slider.confidence")} 🛡️</span>
									</div>
									<Button
										size="sm"
										variant="outline"
										className="h-7 shrink-0 gap-1.5 text-xs"
										disabled={refining}
										onClick={() => refineTopFormulas(3)}
										title={t("formulaLab:refine.tooltip")}
									>
										{refining ? (
											<Loader2 className="h-3.5 w-3.5 animate-spin" />
										) : (
											<Sparkles className="h-3.5 w-3.5 text-primary" />
										)}
										{refining
											? t("formulaLab:refine.running")
											: t("formulaLab:refine.cta")}
									</Button>
								</div>
								<input
									type="range"
									min={0}
									max={100}
									value={Math.round(weight * 100)}
									onChange={(e) => setWeight(Number(e.target.value) / 100)}
									className="h-2 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-emerald-400 via-amber-300 to-sky-400 accent-primary"
									aria-label={t("formulaLab:slider.preference")}
								/>
								{/* Cost provenance: states whether figures are calibrated on
								    real project runs or fall back to heuristic volumes. */}
								<p
									className={`mt-2 flex items-center gap-1.5 text-2xs ${
										(matrix.history_tasks ?? 0) > 0
											? "text-success dark:text-success"
											: "text-muted-foreground"
									}`}
								>
									{(matrix.history_tasks ?? 0) > 0 ? (
										<Database className="h-3 w-3 shrink-0" />
									) : (
										<Info className="h-3 w-3 shrink-0" />
									)}
									{(matrix.history_tasks ?? 0) > 0
										? t("formulaLab:costBasis.calibrated", {
												count: matrix.history_tasks,
											})
										: t("formulaLab:costBasis.heuristic")}
								</p>
								{(matrix.bench_samples ?? 0) > 0 && (
									<p className="mt-1 flex items-center gap-1.5 text-2xs text-success ">
										<FlaskConical className="h-3 w-3 shrink-0" />
										{t("formulaLab:costBasis.bench", {
											count: matrix.bench_samples,
										})}
									</p>
								)}
								{refineError && (
									<p className="mt-1.5 text-2xs text-warning ">
										{t("formulaLab:refine.error")}
									</p>
								)}
							</div>

							{/* Smart picks */}
							<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
								{PICKS.map(({ id, icon, accent }) => {
									const pick = picks[id];
									if (!pick) return null;
									const key = formulaKey(pick);
									return (
										<FormulaCard
											key={id}
											formula={pick}
											pickLabel={`${icon} ${t(`formulaLab:picks.${id}`)}`}
											accent={accent}
											selected={selectedKey === key}
											applied={appliedKey === key}
											applying={applying}
											onSelect={() => setSelectedKey(key)}
											onApply={() => handleApply(pick)}
										/>
									);
								})}
							</div>

							{/* Efficiency frontier chart */}
							<EfficiencyFrontier
								formulas={filtered}
								selectedKey={selectedKey}
								paretoKeys={pareto}
								onSelect={(f) => setSelectedKey(formulaKey(f))}
							/>

							{/* Filters */}
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<div className="relative">
									<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input
										type="search"
										value={search}
										onChange={(e) => setSearch(e.target.value)}
										placeholder={t("formulaLab:filters.searchPlaceholder")}
										aria-label={t("formulaLab:filters.searchPlaceholder")}
										className="h-8 w-44 pl-7 pr-2 text-xs"
									/>
								</div>
								<NativeSelect
									value={providerFilter}
									onChange={(e) => setProviderFilter(e.target.value)}
									aria-label={t("formulaLab:filters.provider")}
									className="h-8 px-2 text-xs"
								>
									<option value="all">{t("formulaLab:filters.allProviders")}</option>
									{providers.map((p) => (
										<option key={p} value={p}>
											{providerName(p)}
										</option>
									))}
								</NativeSelect>
								<div className="flex items-center gap-1">
									{EFFORT_ORDER.map((effort) => (
										<button
											key={effort}
											type="button"
											onClick={() => toggleEffort(effort)}
											aria-pressed={effortFilter.has(effort)}
											className={`rounded-md border px-2 py-1 transition-colors ${
												effortFilter.has(effort)
													? "border-primary bg-primary/10 text-primary"
													: "border-border text-muted-foreground"
											}`}
										>
											{effortLabel(effort, t)}
										</button>
									))}
								</div>
								<div className="ml-auto flex items-center gap-1.5">
									<Switch
										id={perTokenId}
										checked={perTokenOnly}
										onCheckedChange={setPerTokenOnly}
									/>
									<label htmlFor={perTokenId}>
										{t("formulaLab:filters.perTokenOnly")}
									</label>
								</div>
								<span className="text-muted-foreground">
									{t("formulaLab:filters.count", { count: filtered.length })}
								</span>
							</div>

							{/* Ranked table */}
							<div className="overflow-hidden rounded-xl border">
								<table className="w-full text-xs">
									<thead className="sticky top-0 z-10 bg-muted text-left text-2xs text-muted-foreground">
										<tr>
											{sortHeader("formula", "formulaLab:table.formula")}
											{sortHeader("effort", "formulaLab:table.effort")}
											{sortHeader("tokens", "formulaLab:table.tokens", "right")}
											{sortHeader("cost", "formulaLab:table.cost", "right")}
											{sortHeader("success", "formulaLab:table.success", "center")}
											<th className="p-2" />
										</tr>
									</thead>
									<tbody>
										{ranked.slice(0, MAX_ROWS).map((f) => {
											const key = formulaKey(f);
											const isSel = key === selectedKey;
											const name = `${shortModel(f.model)} · ${effortLabel(f.effort, t)}`;
											return (
												<tr
													key={key}
													onClick={() => setSelectedKey(key)}
													className={`cursor-pointer border-t transition-colors hover:bg-muted/40 ${
														isSel ? "bg-primary/5" : ""
													}`}
												>
													<td className="p-2">
														<div className="flex items-center gap-1.5">
															<span
																className="h-2 w-2 shrink-0 rounded-full"
																style={{
																	backgroundColor: providerColor(f.provider),
																}}
															/>
															<button
																type="button"
																onClick={() => setSelectedKey(key)}
																aria-pressed={isSel}
																aria-label={t("formulaLab:selectFormula", {
																	formula: `${providerName(f.provider)} ${name}`,
																})}
																className="font-medium hover:underline"
															>
																{shortModel(f.model)}
															</button>
															<span className="text-muted-foreground">
																{providerName(f.provider)}
															</span>
															{f.provider === "ollama" &&
																(f.installed ? (
																	<Badge
																		variant="outline"
																		className="gap-1 border-success/40 text-3xs text-success "
																		title={t("formulaLab:local.installedTooltip")}
																	>
																		<HardDriveDownload className="h-2.5 w-2.5" />
																		{t("formulaLab:local.installed")}
																	</Badge>
																) : (
																	<Badge
																		variant="outline"
																		className="gap-1 text-3xs text-muted-foreground"
																		title={t("formulaLab:local.notInstalledTooltip")}
																	>
																		<Download className="h-2.5 w-2.5" />
																		{t("formulaLab:local.notInstalled")}
																	</Badge>
																))}
														</div>
													</td>
													<td className="p-2">
														<Badge variant="outline" className="text-3xs">
															{effortLabel(f.effort, t)}
														</Badge>
													</td>
													<td className="p-2 text-right tabular-nums text-muted-foreground">
														{formatTokens(totalTokens(f))}
													</td>
													<td className="p-2 text-right font-medium tabular-nums">
														<span className="inline-flex items-center justify-end gap-1">
															{f.cost_basis === "measured" && (
																<span
																	role="img"
																	title={t("formulaLab:costBasis.measuredTooltip")}
																	aria-label={t("formulaLab:costBasis.measuredTooltip")}
																	className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
																/>
															)}
															{formatCostBand(f)}
														</span>
													</td>
													<td className="p-2">
														<div className="flex items-center justify-center gap-1">
															<SuccessRing
																value={f.success_probability}
																size={30}
																stroke={3}
															/>
															{f.ai_refined && (
																<span
																	role="img"
																	title={f.refine_reason || t("formulaLab:refine.aiBadge")}
																	aria-label={t("formulaLab:refine.aiBadge")}
																>
																	<Sparkles className="h-3 w-3 text-primary" />
																</span>
															)}
														</div>
													</td>
													<td className="p-2 text-right">
														<Button
															size="sm"
															variant={isSel ? "default" : "ghost"}
															className="h-7 text-2xs"
															disabled={applying}
															aria-label={t("formulaLab:applyFormula", {
																formula: `${providerName(f.provider)} ${name}`,
															})}
															onClick={(e) => {
																e.stopPropagation();
																handleApply(f);
															}}
														>
															{t("formulaLab:apply")}
														</Button>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
								{ranked.length > MAX_ROWS && (
									<div className="border-t bg-muted/30 p-2 text-center text-2xs text-muted-foreground">
										{t("formulaLab:table.more", {
											count: ranked.length - MAX_ROWS,
										})}
									</div>
								)}
							</div>
						</div>
					</div>
				)}

				{/* Footer: selected summary + apply */}
				{selectedFormula && !loading && (
					<div className="flex items-center justify-between border-t pt-3">
						<div className="flex items-center gap-3 text-sm">
							<SuccessRing
								value={selectedFormula.success_probability}
								size={36}
							/>
							<div>
								<div className="font-semibold">
									{shortModel(selectedFormula.model)} ·{" "}
									{effortLabel(selectedFormula.effort, t)}
								</div>
								<div className="text-xs text-muted-foreground">
									{providerName(selectedFormula.provider)} · {formatCostBand(selectedFormula)}
								</div>
							</div>
						</div>
						<Button
							className="gap-1.5"
							disabled={applying}
							onClick={() => handleApply(selectedFormula)}
						>
							{applying && <Loader2 className="h-4 w-4 animate-spin" />}
							{t("formulaLab:applySelected")}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

export default FormulaLab;
