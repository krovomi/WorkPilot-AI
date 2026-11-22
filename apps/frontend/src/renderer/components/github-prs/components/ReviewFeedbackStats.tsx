/**
 * The project's feedback on PR review findings, as a whole (#361, lot 2):
 * acceptance rate per category, the kinds of finding the reviewer now
 * downgrades or hides, a reset for each, and the conventions file. On a
 * server project (lot 3), the rejections held for a maintainer; a reset is a
 * maintainer's, and the conventions file is saved where the person chooses
 * (lot 4), since the server's clone is nobody's working copy. Folded by
 * default and loaded when opened: a PR view does not read the dataset for it.
 */

import { BarChart3, FileText, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ReviewFeedbackCategoryStats,
	ReviewFeedbackRuleStats,
} from "../../../../shared/types/review-feedback";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
	type ReviewFeedbackStatsState,
	useReviewFeedbackStats,
} from "../hooks/useReviewFeedbackStats";
import { ReviewFeedbackHeld } from "./ReviewFeedbackHeld";

function rated(row: ReviewFeedbackCategoryStats): number {
	return row.accepted + row.rejected + row.notApplicable;
}

/** `whole` is never 0: a category is listed once a finding of it was rated. */
function percent(part: number, whole: number): number {
	return Math.round((part / whole) * 100);
}

function CategoryTable({ rows }: { rows: ReviewFeedbackCategoryStats[] }) {
	const { t } = useTranslation("reviewFeedback");
	return (
		<table className="w-full text-xs">
			<caption className="text-left font-medium text-foreground pb-1">
				{t("byCategory")}
			</caption>
			<thead>
				<tr className="text-muted-foreground">
					<th scope="col" className="text-left font-normal py-1">
						{t("columns.category")}
					</th>
					<th scope="col" className="text-right font-normal">
						{t("columns.accepted")}
					</th>
					<th scope="col" className="text-right font-normal">
						{t("columns.rejected")}
					</th>
					<th scope="col" className="text-right font-normal">
						{t("columns.notApplicable")}
					</th>
					<th scope="col" className="text-right font-normal">
						{t("columns.rate")}
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.category} className="border-t border-border/50">
						<td className="py-1">
							<code>{row.category}</code>
						</td>
						<td className="text-right">{row.accepted}</td>
						<td className="text-right">{row.rejected}</td>
						<td className="text-right">{row.notApplicable}</td>
						<td className="text-right">
							{t("rate", { rate: percent(row.accepted, rated(row)) })}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function RuleItem({
	rule,
	state,
}: {
	rule: ReviewFeedbackRuleStats;
	state: ReviewFeedbackStatsState;
}) {
	const { t } = useTranslation(["reviewFeedback", "common"]);
	return (
		<li className="flex items-start gap-2 border-t border-border/50 pt-2">
			<div className="flex-1 min-w-0 space-y-1">
				<div className="flex items-center gap-2 flex-wrap">
					<Badge variant={rule.status === "dropped" ? "muted" : "warning"}>
						{t(`reviewFeedback:status.${rule.status}`)}
					</Badge>
					<code className="bg-muted px-1 rounded">{rule.category}</code>
					<span className="font-medium text-foreground break-words">
						{rule.label}
					</span>
				</div>
				<p className="text-muted-foreground">
					{t("reviewFeedback:counts", {
						rejected: rule.rejections,
						accepted: rule.accepts,
					})}
					{rule.topReason && (
						<>
							{" · "}
							{t("reviewFeedback:mostly", {
								reason: t(`common:prReview.feedback.reasons.${rule.topReason}`),
							})}
						</>
					)}
				</p>
			</div>
			{canReset(state) && (
				<Button
				type="button"
				variant="outline"
				size="sm"
				className="h-7 px-2 text-xs shrink-0"
				disabled={state.pendingSignature !== null}
				aria-label={t("reviewFeedback:resetLabel", { label: rule.label })}
				onClick={() => void state.reset(rule.signature)}
			>
				<RotateCcw className="h-3 w-3 mr-1" />
				{t("reviewFeedback:reset")}
				</Button>
			)}
		</li>
	);
}

/** A server project's rule is reset by a maintainer only (the server checks it). */
function canReset(state: ReviewFeedbackStatsState): boolean {
	const server = state.stats?.server;
	return !server || server.maintainer;
}

function StatsBody({ state }: { state: ReviewFeedbackStatsState }) {
	const { t } = useTranslation("reviewFeedback");
	const { stats } = state;
	if (!stats) {
		return state.loading ? <p>{t("loading")}</p> : null;
	}
	if (stats.categories.length === 0) return <p>{t("empty")}</p>;
	const total = stats.categories.reduce((sum, row) => sum + rated(row), 0);
	const accepted = stats.categories.reduce((sum, row) => sum + row.accepted, 0);
	return (
		<div className="space-y-3">
			<p className="text-foreground">
				{t("overall", { rate: percent(accepted, total), total })}
			</p>
			<CategoryTable rows={stats.categories} />
			<div className="space-y-2">
				<p className="font-medium text-foreground">{t("rulesTitle")}</p>
				<p>{t("rulesHint", { threshold: stats.threshold })}</p>
				{stats.rules.length === 0 ? (
					<p>{t("noRules")}</p>
				) : (
					<>
						<p>{t(canReset(state) ? "resetHint" : "maintainerOnly")}</p>
						<ul className="space-y-2">
							{stats.rules.map((rule) => (
								<RuleItem key={rule.signature} rule={rule} state={state} />
							))}
						</ul>
					</>
				)}
			</div>
		</div>
	);
}

export function ReviewFeedbackStats({ projectId }: { projectId: string }) {
	const { t } = useTranslation("reviewFeedback");
	const state = useReviewFeedbackStats(projectId);
	const [open, setOpen] = useState(false);
	const server = Boolean(state.stats?.server);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next) void state.load();
	};

	return (
		<section
			className="rounded-lg border p-3 text-xs text-muted-foreground space-y-3"
			aria-label={t("title")}
		>
			<div className="flex items-center gap-2 flex-wrap">
				<BarChart3 className="h-3.5 w-3.5 shrink-0" />
				<span className="flex-1 font-medium text-foreground">{t("title")}</span>
				{open && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						disabled={state.loading}
						onClick={() => void state.load()}
					>
						<RefreshCw className="h-3 w-3 mr-1" />
						{t("refresh")}
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-xs"
					aria-expanded={open}
					onClick={toggle}
				>
					{open ? t("hide") : t("show")}
				</Button>
			</div>
			{open && (
				<>
					<p>{t("subtitle")}</p>
					{state.error && (
						<p className="text-destructive" role="alert">
							{t(`errors.${state.error}`)}
						</p>
					)}
					<StatsBody state={state} />
					<ReviewFeedbackHeld state={state} />
					<div className="space-y-1 border-t border-border/50 pt-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 px-2 text-xs"
							disabled={state.writing}
							onClick={() => void state.writeConventions()}
						>
							<FileText className="h-3 w-3 mr-1" />
							{t(server ? "conventions.save" : "conventions.write")}
						</Button>
						<p>{t(server ? "conventions.saveHint" : "conventions.hint")}</p>
						{state.written && (
							<p className="text-success" role="status">
								{t("conventions.written", {
									path: state.written.path,
									count: state.written.rules,
								})}
							</p>
						)}
					</div>
				</>
			)}
		</section>
	);
}
