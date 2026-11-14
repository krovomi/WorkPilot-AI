/**
 * #3.8 Codebase Longevity Score panel.
 *
 * One-shot scan: enter project path → POST /api/longevity/score → render
 * grade + score + penalties + 6-month projection + riskiest files.
 */

import { useTranslation } from "react-i18next";
import { useLongevityStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

interface LongevityPanelProps {
	projectPath: string;
}

const GRADE_COLOR: Record<string, string> = {
	A: "bg-success/20 text-success border-success/40",
	B: "bg-success/20 text-success border-success/40",
	C: "bg-warning/20 text-warning border-warning/40",
	D: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	F: "bg-destructive/20 text-destructive border-destructive/40",
};

export function LongevityPanel({ projectPath }: LongevityPanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, report, compute } = useLongevityStore();
	const isRunning = phase === "running";

	return (
		<PanelShell
			title={t("longevity.title")}
			subtitle={t("longevity.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => compute(projectPath)}
					disabled={isRunning || !projectPath}
				>
					{isRunning ? t("common.running") : t("longevity.compute")}
				</Button>
			}
		>
			{!projectPath && (
				<p className="text-sm text-muted-foreground">{t("common.projectPathRequired")}</p>
			)}
			{!report && projectPath && (
				<p className="text-sm text-muted-foreground">{t("common.noData")}</p>
			)}
			{report && (
				<div className="space-y-4">
					<div className="flex items-center gap-4">
						<div className="text-4xl font-bold">{report.score.toFixed(1)}</div>
						<Badge className={GRADE_COLOR[report.grade] ?? "bg-muted"}>
							{t("longevity.gradeValue", { grade: report.grade })}
						</Badge>
						<div className="text-sm text-muted-foreground">
							{t("longevity.loc")}: {report.summary.loc.toLocaleString()} ·{" "}
							{t("longevity.debtItems")}: {report.summary.total_debt_items}
						</div>
					</div>

					<div className="grid grid-cols-2 gap-4 text-sm">
						<div>
							<div className="font-medium mb-1">{t("longevity.penalties")}</div>
							<ul className="space-y-1">
								{Object.entries(report.penalties).map(([k, v]) => (
									<li key={k} className="flex justify-between">
										<span className="text-muted-foreground">
											{t(`longevity.signals.${k}` as never, { defaultValue: k })}
										</span>
										<span>−{v.toFixed(2)}</span>
									</li>
								))}
							</ul>
						</div>
						<div>
							<div className="font-medium mb-1">{t("longevity.bonuses")}</div>
							<ul className="space-y-1">
								{Object.entries(report.bonuses).length === 0 ? (
									<li className="text-muted-foreground">—</li>
								) : (
									Object.entries(report.bonuses).map(([k, v]) => (
										<li key={k} className="flex justify-between">
											<span className="text-muted-foreground">
												{t(`longevity.signals.${k}` as never, { defaultValue: k })}
											</span>
											<span>{v >= 0 ? "+" : ""}{v.toFixed(2)}</span>
										</li>
									))
								)}
							</ul>
						</div>
					</div>

					{report.projection && (
						<div className="rounded border p-3 text-sm">
							<div className="font-medium mb-1">{t("longevity.projection")}</div>
							<div>
								{report.projection.projected_score_in_6_months.toFixed(1)} (
								{report.projection.projected_grade_in_6_months}) ·{" "}
								<span className="text-muted-foreground">
									{t(`longevity.direction${report.projection.direction[0].toUpperCase()}${report.projection.direction.slice(1)}` as never)}
								</span>
							</div>
						</div>
					)}

					{report.riskiest_files.length > 0 && (
						<div>
							<div className="font-medium mb-1">{t("longevity.riskiest")}</div>
							<ul className="space-y-1 text-sm">
								{report.riskiest_files.map((f) => (
									<li key={f.file_path} className="flex justify-between gap-4">
										<span className="font-mono truncate">{f.file_path}</span>
										<span className="text-muted-foreground whitespace-nowrap">
											{f.items} {t("longevity.items")} · {t("longevity.cost")}{" "}
											{f.total_cost.toFixed(1)}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
		</PanelShell>
	);
}
