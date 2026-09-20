import { FlaskConical, GitCompare, Trophy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
	BountyContestant,
	BountyEvidence,
} from "../../../preload/api/modules/bounty-board-api";

interface Props {
	readonly contestant: BountyContestant;
	readonly isWinner?: boolean;
	readonly rationale?: string;
}

const STATUS_STYLES: Record<BountyContestant["status"], string> = {
	queued: "bg-muted text-muted-foreground",
	running: "bg-blue-500/15 text-blue-500",
	completed: "bg-green-500/15 text-green-500",
	archived: "bg-zinc-500/15 text-zinc-500",
	error: "bg-red-500/15 text-red-500",
	winner: "bg-yellow-500/15 text-yellow-500",
};

/**
 * A test status carries a verdict or an absence, never both, and the card has
 * to say which. `failed` is red because the suite ran and said no; every other
 * non-passing status is muted because nobody measured anything — the same
 * distinction the judge makes when it renormalises a missing criterion out of
 * the total instead of scoring it zero.
 */
const TEST_STATUS_STYLES: Record<BountyEvidence["tests"]["status"], string> = {
	passed: "text-green-500",
	failed: "text-red-500",
	timeout: "text-muted-foreground",
	"no-command": "text-muted-foreground",
	"no-change": "text-muted-foreground",
	skipped: "text-muted-foreground",
	error: "text-muted-foreground",
};

function EvidenceRow({ evidence }: { readonly evidence: BountyEvidence }) {
	const { t } = useTranslation(["bountyBoard"]);
	const { diff, tests } = evidence;

	const diffLabel = diff.available
		? t("bountyBoard:evidence.diff", {
				files: diff.files_changed,
				added: diff.insertions,
				removed: diff.deletions,
				defaultValue: "{{files}} files · +{{added}} −{{removed}}",
			})
		: t("bountyBoard:evidence.diffUnavailable", "diff not measured");

	const testLabel = t(`bountyBoard:evidence.tests.${tests.status}`, {
		passed: tests.passed,
		failed: tests.failed,
		defaultValue: tests.status,
	});

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
			<span className="inline-flex items-center gap-1 text-muted-foreground">
				<GitCompare className="w-3 h-3" aria-hidden="true" />
				{diffLabel}
			</span>
			<span
				className={`inline-flex items-center gap-1 ${TEST_STATUS_STYLES[tests.status] ?? "text-muted-foreground"}`}
			>
				<FlaskConical className="w-3 h-3" aria-hidden="true" />
				{testLabel}
			</span>
		</div>
	);
}

export function ContestantCard({ contestant, isWinner, rationale }: Props) {
	const { t } = useTranslation(["bountyBoard", "common"]);
	const statusClass = STATUS_STYLES[contestant.status] ?? STATUS_STYLES.queued;
	const breakdown = Object.entries(contestant.quality_breakdown ?? {});

	return (
		<div
			className={`border rounded-md p-3 bg-card flex flex-col gap-2 ${isWinner ? "ring-2 ring-yellow-500/60" : ""}`}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-sm font-semibold">{contestant.label}</span>
					{isWinner && <Trophy className="w-4 h-4 text-yellow-500" />}
					{contestant.status === "error" && (
						<X className="w-4 h-4 text-red-500" />
					)}
				</div>
				<span
					className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${statusClass}`}
				>
					{t(`bountyBoard:status.${contestant.status}`, contestant.status)}
				</span>
			</div>

			<div className="text-xs text-muted-foreground">
				{contestant.provider}:{contestant.model}
			</div>

			<div className="grid grid-cols-3 gap-2 text-[11px]">
				<div>
					<div className="text-muted-foreground">
						{t("bountyBoard:metrics.score", "Score")}
					</div>
					<div className="font-mono font-semibold">
						{contestant.score != null ? contestant.score.toFixed(1) : "—"}
					</div>
				</div>
				<div>
					<div className="text-muted-foreground">
						{t("bountyBoard:metrics.tokens", "Tokens")}
					</div>
					<div className="font-mono">{contestant.tokens_used}</div>
				</div>
				<div>
					<div className="text-muted-foreground">
						{t("bountyBoard:metrics.duration", "Duration")}
					</div>
					<div className="font-mono">
						{(contestant.duration_ms / 1000).toFixed(1)} s
					</div>
				</div>
			</div>

			{contestant.evidence && <EvidenceRow evidence={contestant.evidence} />}

			{breakdown.length > 0 && (
				<div className="text-[10px] text-muted-foreground flex flex-wrap gap-2">
					{breakdown.map(([criterion, points]) => (
						<span
							key={criterion}
							className={`px-1.5 py-0.5 rounded ${points == null ? "bg-muted/50 italic" : "bg-muted"}`}
							title={
								points == null
									? t(
											"bountyBoard:criteria.notMeasuredHint",
											"No evidence for this criterion — its weight was redistributed over the others.",
										)
									: undefined
							}
						>
							{t(`bountyBoard:criteria.${criterion}`, criterion)}:{" "}
							{/* An unmeasured criterion is not a zero. Printing `0` here
							    would say the contestant was judged and found wanting, when
							    in fact nothing was judged at all. */}
							{points == null
								? t("bountyBoard:criteria.notMeasured", "not measured")
								: points.toFixed(1)}
						</span>
					))}
				</div>
			)}

			{rationale && (
				<div className="text-[11px] text-muted-foreground italic border-t border-border pt-2">
					{rationale}
				</div>
			)}

			{contestant.error && (
				<div className="text-[11px] text-red-500 border-t border-red-500/30 pt-2">
					{contestant.error}
				</div>
			)}
		</div>
	);
}
