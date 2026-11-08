import ReactMarkdown from "react-markdown";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import { useTranslation } from "react-i18next";
import { Chip, Gauge, Panel, Stat, Stats, type Tone } from "../charter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewIssue {
	rule: string;
	severity: string;
	message: string;
	line?: number;
	file?: string;
	suggestion?: string;
}

export interface ReviewResult {
	score: number;
	issues: ReviewIssue[];
	summary?: string;
	passed: boolean;
}

const SEVERITY: Record<string, { tone: Tone; icon: React.ElementType }> = {
	critical: { tone: "red", icon: XCircle },
	high: { tone: "red", icon: XCircle },
	medium: { tone: "amber", icon: AlertTriangle },
	low: { tone: "blue", icon: Info },
	info: { tone: "muted", icon: Info },
};

const severityOf = (severity: string) => SEVERITY[severity.toLowerCase()] ?? SEVERITY.info;

function scoreTone(score: number, blocked: boolean): Tone {
	if (blocked) return "red";
	if (score >= 80) return "green";
	return score >= 60 ? "amber" : "red";
}

function scoreLabel(score: number, blocked: boolean): string {
	if (blocked) return "codeReview:score.blocked";
	if (score >= 80) return "codeReview:score.good";
	return score >= 60 ? "codeReview:score.needsImprovement" : "codeReview:score.poor";
}

export function ReviewResults({
	result,
	onNavigate,
}: {
	result: ReviewResult | null;
	onNavigate: (file: string, line: number) => void;
}) {
	const { t } = useTranslation(["codeReview"]);
	if (!result) return null;
	const blocked = !result.passed;
	const tone = scoreTone(result.score, blocked);
	const severe = result.issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
	return (
		<div className="flex flex-col gap-3">
			<Panel rail tone={tone} className="flex items-center gap-4">
				<Gauge value={result.score} tone={tone} size={72} label={String(result.score)} />
				<div className="min-w-0">
					<span className="wp-kicker">{t("codeReview:score.qualityScore")}</span>
					<p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
						{result.passed ? (
							<CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
						) : (
							<XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
						)}
						{result.passed ? t("codeReview:result.passed") : t("codeReview:result.failed")}
					</p>
					<p className="wp-meta mt-0.5">{t(scoreLabel(result.score, blocked))}</p>
				</div>
			</Panel>
			<Stats>
				<Stat label={t("codeReview:issues.title")} value={result.issues.length} />
				<Stat label={t("codeReview:result.criticalHigh")} value={severe} tone={severe ? "red" : "green"} />
			</Stats>
			{result.summary && (
				<Panel>
					<div className="prose prose-sm dark:prose-invert max-w-none text-xs text-muted-foreground">
						<ReactMarkdown>{result.summary}</ReactMarkdown>
					</div>
				</Panel>
			)}
			{result.issues.length > 0 && (
				<div className="flex flex-col gap-2">
					<h3 className="wp-kicker">{t("codeReview:issues.title")}</h3>
					{result.issues.map((issue, idx) => {
						const sev = severityOf(issue.severity);
						const Icon = sev.icon;
						return (
							<Panel
								// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
								key={idx}
								rail
								tone={sev.tone}
								className="flex flex-col gap-1.5"
							>
								<div className="flex flex-wrap items-center gap-2">
									<Chip tone={sev.tone} dot={false}>
										<Icon className="h-3 w-3" aria-hidden="true" />
										{t(`severity.${issue.severity}`)}
									</Chip>
									<span className="wp-meta">{issue.rule}</span>
									{issue.file && (
										<button
											type="button"
											className="wp-mono break-all text-left text-xs text-primary underline underline-offset-2"
											onClick={() => issue.file && onNavigate(issue.file, issue.line || 1)}
										>
											{issue.file}:{issue.line || 1}
										</button>
									)}
								</div>
								<p className="text-sm">{issue.message}</p>
								{issue.suggestion && (
									<p className="wp-code">
										<span className="wp-kicker mr-1">{t("codeReview:issues.suggestion")}</span>
										{issue.suggestion}
									</p>
								)}
							</Panel>
						);
					})}
				</div>
			)}
		</div>
	);
}
