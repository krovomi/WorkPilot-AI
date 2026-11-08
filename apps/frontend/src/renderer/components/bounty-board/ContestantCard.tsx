import { FlaskConical, GitCompare, Trophy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Chip, type Tone, toneClass } from "../charter";
import type {
	BountyContestant,
	BountyEvidence,
} from "../../../preload/api/modules/bounty-board-api";

interface Props {
	readonly contestant: BountyContestant;
	readonly isWinner?: boolean;
	readonly rationale?: string;
}

const STATUS_TONE: Record<BountyContestant["status"], Tone> = {
	queued: "muted",
	running: "blue",
	completed: "green",
	archived: "muted",
	error: "red",
	winner: "amber",
};

/**
 * A test status carries a verdict or an absence, never both, and the card has
 * to say which. `failed` is red because the suite ran and said no; every other
 * non-passing status is muted because nobody measured anything — the same
 * distinction the judge makes when it renormalises a missing criterion out of
 * the total instead of scoring it zero.
 */
const TEST_STATUS_STYLES: Record<BountyEvidence["tests"]["status"], string> = {
	passed: "text-success",
	failed: "text-destructive",
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
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
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
	const tone = isWinner ? "amber" : (STATUS_TONE[contestant.status] ?? "muted");
	const breakdown = Object.entries(contestant.quality_breakdown ?? {});

	return (
		<div
			className={`wp-card wp-card-pad wp-rail flex flex-col gap-2 ${toneClass(tone) ?? ""}`}
			data-active={isWinner ? "true" : undefined}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="wp-step-title">{contestant.label}</span>
					{isWinner && <Trophy className="w-4 h-4 text-warning" />}
					{contestant.status === "error" && (
						<X className="w-4 h-4 text-destructive" />
					)}
				</div>
				<Chip tone={STATUS_TONE[contestant.status] ?? "muted"}>
					{t(`bountyBoard:status.${contestant.status}`, contestant.status)}
				</Chip>
			</div>

			<div className="wp-meta">
				{contestant.provider}:{contestant.model}
			</div>

			<div className="grid grid-cols-3 gap-2 text-2xs">
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
				<div className="text-3xs text-muted-foreground flex flex-wrap gap-2">
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
				<div className="text-2xs text-muted-foreground italic border-t border-border pt-2">
					{rationale}
				</div>
			)}

			{contestant.error && (
				<div className="text-2xs text-destructive border-t border-destructive/30 pt-2">
					{contestant.error}
				</div>
			)}
		</div>
	);
}
