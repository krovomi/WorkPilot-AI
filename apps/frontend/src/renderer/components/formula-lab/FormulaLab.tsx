import { Loader2, RotateCw, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { EfficiencyFrontier } from "./EfficiencyFrontier";
import { FormulaCard } from "./FormulaCard";
import {
	EFFORT_ORDER,
	effortLabel,
	formatCostBand,
	formatTokens,
	providerColor,
	shortModel,
	totalTokens,
} from "./formula-utils";
import { SuccessRing } from "./SuccessRing";

const MAX_ROWS = 48;

export function FormulaLab() {
	const { t } = useTranslation(["formulaLab", "common"]);
	const { toast } = useToast();
	const {
		isOpen,
		ticketTitle,
		matrix,
		loading,
		error,
		weight,
		selectedKey,
		applying,
		refining,
		refineError,
		setWeight,
		setSelectedKey,
		closeLab,
		fetchMatrix,
		applyFormula,
		refineTopFormulas,
	} = useFormulaMatrixStore();

	const [providerFilter, setProviderFilter] = useState<string>("all");
	const [effortFilter, setEffortFilter] = useState<Set<string>>(
		() => new Set(EFFORT_ORDER),
	);
	const [perTokenOnly, setPerTokenOnly] = useState(false);

	const allFormulas = matrix?.formulas ?? [];

	const providers = useMemo(
		() =>
			Array.from(new Set(allFormulas.map((f) => f.provider))).sort((a, b) =>
				a.localeCompare(b),
			),
		[allFormulas],
	);

	const filtered = useMemo(
		() =>
			allFormulas.filter(
				(f) =>
					(providerFilter === "all" || f.provider === providerFilter) &&
					effortFilter.has(f.effort) &&
					(!perTokenOnly || f.per_token_billed),
			),
		[allFormulas, providerFilter, effortFilter, perTokenOnly],
	);

	const ranked = useMemo(
		() => rankFormulas(filtered, weight),
		[filtered, weight],
	);
	const picks = useMemo(() => pickSmart(filtered), [filtered]);
	const pareto = useMemo(() => paretoFront(filtered), [filtered]);

	const selectedFormula =
		ranked.find((f) => formulaKey(f) === selectedKey) ?? null;

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
						effort: effortLabel(formula.effort),
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
					<ScrollArea className="flex-1 pr-3">
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
								{refineError && (
									<p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
										{t("formulaLab:refine.error")}
									</p>
								)}
							</div>

							{/* Smart picks */}
							<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
								{picks.bestValue && (
									<FormulaCard
										formula={picks.bestValue}
										pickLabel={`🏆 ${t("formulaLab:picks.bestValue")}`}
										accent="#16a34a"
										selected={selectedKey === formulaKey(picks.bestValue)}
										applied={selectedKey === formulaKey(picks.bestValue)}
										applying={applying}
										onSelect={() => setSelectedKey(formulaKey(picks.bestValue!))}
										onApply={() => handleApply(picks.bestValue!)}
									/>
								)}
								{picks.safest && (
									<FormulaCard
										formula={picks.safest}
										pickLabel={`🛡️ ${t("formulaLab:picks.safest")}`}
										accent="#0ea5e9"
										selected={selectedKey === formulaKey(picks.safest)}
										applying={applying}
										onSelect={() => setSelectedKey(formulaKey(picks.safest!))}
										onApply={() => handleApply(picks.safest!)}
									/>
								)}
								{picks.cheapest && (
									<FormulaCard
										formula={picks.cheapest}
										pickLabel={`💸 ${t("formulaLab:picks.cheapest")}`}
										accent="#f59e0b"
										selected={selectedKey === formulaKey(picks.cheapest)}
										applying={applying}
										onSelect={() => setSelectedKey(formulaKey(picks.cheapest!))}
										onApply={() => handleApply(picks.cheapest!)}
									/>
								)}
								{picks.fastest && (
									<FormulaCard
										formula={picks.fastest}
										pickLabel={`⚡ ${t("formulaLab:picks.fastest")}`}
										accent="#8b5cf6"
										selected={selectedKey === formulaKey(picks.fastest)}
										applying={applying}
										onSelect={() => setSelectedKey(formulaKey(picks.fastest!))}
										onApply={() => handleApply(picks.fastest!)}
									/>
								)}
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
								<select
									value={providerFilter}
									onChange={(e) => setProviderFilter(e.target.value)}
									className="h-8 rounded-md border border-border bg-card px-2 text-xs"
								>
									<option value="all">{t("formulaLab:filters.allProviders")}</option>
									{providers.map((p) => (
										<option key={p} value={p}>
											{p}
										</option>
									))}
								</select>
								<div className="flex items-center gap-1">
									{EFFORT_ORDER.map((effort) => (
										<button
											key={effort}
											type="button"
											onClick={() => toggleEffort(effort)}
											className={`rounded-md border px-2 py-1 transition-colors ${
												effortFilter.has(effort)
													? "border-primary bg-primary/10 text-primary"
													: "border-border text-muted-foreground"
											}`}
										>
											{effortLabel(effort)}
										</button>
									))}
								</div>
								<label className="ml-auto flex items-center gap-1.5">
									<Switch
										checked={perTokenOnly}
										onCheckedChange={setPerTokenOnly}
									/>
									{t("formulaLab:filters.perTokenOnly")}
								</label>
								<span className="text-muted-foreground">
									{t("formulaLab:filters.count", { count: filtered.length })}
								</span>
							</div>

							{/* Ranked table */}
							<div className="overflow-hidden rounded-xl border">
								<table className="w-full text-xs">
									<thead className="bg-muted/50 text-left text-[11px] text-muted-foreground">
										<tr>
											<th className="p-2 font-medium">
												{t("formulaLab:table.formula")}
											</th>
											<th className="p-2 font-medium">
												{t("formulaLab:table.effort")}
											</th>
											<th className="p-2 text-right font-medium">
												{t("formulaLab:table.tokens")}
											</th>
											<th className="p-2 text-right font-medium">
												{t("formulaLab:table.cost")}
											</th>
											<th className="p-2 text-center font-medium">
												{t("formulaLab:table.success")}
											</th>
											<th className="p-2" />
										</tr>
									</thead>
									<tbody>
										{ranked.slice(0, MAX_ROWS).map((f) => {
											const key = formulaKey(f);
											const isSel = key === selectedKey;
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
															<span className="font-medium">
																{shortModel(f.model)}
															</span>
															<span className="text-muted-foreground">
																{f.provider}
															</span>
														</div>
													</td>
													<td className="p-2">
														<Badge variant="outline" className="text-[10px]">
															{effortLabel(f.effort)}
														</Badge>
													</td>
													<td className="p-2 text-right tabular-nums text-muted-foreground">
														{formatTokens(totalTokens(f))}
													</td>
													<td className="p-2 text-right font-medium tabular-nums">
														{formatCostBand(f)}
													</td>
													<td className="p-2">
														<div className="flex items-center justify-center gap-1">
															<SuccessRing
																value={f.success_probability}
																size={30}
																stroke={3}
															/>
															{f.ai_refined && (
																<span title={f.refine_reason}>
																	<Sparkles className="h-3 w-3 text-primary" />
																</span>
															)}
														</div>
													</td>
													<td className="p-2 text-right">
														<Button
															size="sm"
															variant={isSel ? "default" : "ghost"}
															className="h-7 text-[11px]"
															disabled={applying}
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
									<div className="border-t bg-muted/30 p-2 text-center text-[11px] text-muted-foreground">
										{t("formulaLab:table.more", {
											count: ranked.length - MAX_ROWS,
										})}
									</div>
								)}
							</div>
						</div>
					</ScrollArea>
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
									{effortLabel(selectedFormula.effort)}
								</div>
								<div className="text-xs text-muted-foreground">
									{selectedFormula.provider} · {formatCostBand(selectedFormula)}
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
