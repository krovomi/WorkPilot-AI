import ReactMarkdown from "react-markdown";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";

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

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: string }) {
	const { t } = useTranslation("codeReview");
	const variants: Record<
		string,
		{ className: string; icon: React.ElementType }
	> = {
		critical: {
			className: "bg-red-500/10 text-red-500 border-red-500/20",
			icon: XCircle,
		},
		high: {
			className: "bg-red-400/10 text-red-400 border-red-400/20",
			icon: XCircle,
		},
		medium: {
			className: "bg-amber-500/10 text-amber-500 border-amber-500/20",
			icon: AlertTriangle,
		},
		low: {
			className: "bg-blue-500/10 text-blue-500 border-blue-500/20",
			icon: Info,
		},
		info: {
			className: "bg-gray-500/10 text-gray-500 border-gray-500/20",
			icon: Info,
		},
	};
	const v = variants[severity.toLowerCase()] || variants.info;
	const Icon = v.icon;

	return (
		<Badge variant="outline" className={cn("gap-1 text-xs", v.className)}>
			<Icon className="h-3 w-3" />
			{t(`severity.${severity}`)}
		</Badge>
	);
}

// ---------------------------------------------------------------------------
// Score gauge
// ---------------------------------------------------------------------------

function ScoreGauge({
	score,
	blocked,
	t,
}: {
	score: number;
	blocked: boolean;
	t: (key: string) => string;
}) {
	const color = blocked
		? "text-red-500"
		: score >= 80
			? "text-emerald-500"
			: score >= 60
				? "text-amber-500"
				: "text-red-500";
	const bgColor = blocked
		? "bg-red-500"
		: score >= 80
			? "bg-emerald-500"
			: score >= 60
				? "bg-amber-500"
				: "bg-red-500";

	return (
		<div className="flex items-center gap-4">
			<div className="relative h-20 w-20">
				{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative */}
				<svg className="h-20 w-20 -rotate-90" viewBox="0 0 36 36">
					<path
						d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
						fill="none"
						stroke="currentColor"
						className="text-secondary"
						strokeWidth="3"
					/>
					<path
						d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
						fill="none"
						stroke="currentColor"
						className={color}
						strokeWidth="3"
						strokeDasharray={`${score}, 100`}
						strokeLinecap="round"
					/>
				</svg>
				<div className="absolute inset-0 flex items-center justify-center">
					<span className={cn("text-lg font-bold", color)}>{score}</span>
				</div>
			</div>
			<div>
				<p className="text-sm font-semibold text-foreground">
					{t("codeReview:score.qualityScore")}
				</p>
				<div className="mt-1 flex items-center gap-1.5">
					<div className={cn("h-2 w-2 rounded-full", bgColor)} />
					<span className="text-xs text-muted-foreground">
						{blocked
							? t("codeReview:score.blocked")
							: score >= 80
								? t("codeReview:score.good")
								: score >= 60
									? t("codeReview:score.needsImprovement")
									: t("codeReview:score.poor")}
					</span>
				</div>
			</div>
		</div>
	);
}

export function ReviewResults({
	result,
	onNavigate,
}: {
	result: ReviewResult | null;
	onNavigate: (file: string, line: number) => void;
}) {
	const { t } = useTranslation(["codeReview"]);
	return (
		<div>
			{result && (
				<div className="space-y-6">
					{/* Score & Summary */}
					<div className="grid grid-cols-1 gap-6">
						<Card>
							<CardContent className="p-5">
								<ScoreGauge
									score={result.score}
									blocked={!result.passed}
									t={t}
								/>
							</CardContent>
						</Card>
						<Card>
							<CardContent className="p-5">
								<div className="flex items-center gap-2 mb-3">
									{result.passed ? (
										<CheckCircle2 className="h-5 w-5 text-emerald-500" />
									) : (
										<XCircle className="h-5 w-5 text-red-500" />
									)}
									<span
										className={cn(
											"text-sm font-semibold",
											result.passed ? "text-emerald-500" : "text-red-500",
										)}
									>
										{result.passed
											? t("codeReview:result.passed")
											: t("codeReview:result.failed")}
									</span>
								</div>
								{result.summary && (
									<div className="prose prose-sm dark:prose-invert max-w-none text-xs text-muted-foreground">
										<ReactMarkdown>{result.summary}</ReactMarkdown>
									</div>
								)}
								<div className="mt-3 flex gap-3 text-xs text-muted-foreground">
									<span>
										{result.issues.length}{" "}
										{t("codeReview:result.issues", {
											count: result.issues.length,
										})}
									</span>
									<span>
										{
											result.issues.filter(
												(i) =>
													i.severity === "critical" || i.severity === "high",
											).length
										}{" "}
										{t("codeReview:result.criticalHigh")}
									</span>
								</div>
							</CardContent>
						</Card>
					</div>

					{/* Issues list */}
					{result.issues.length > 0 && (
						<Card>
							<CardContent className="p-5">
								<h3 className="text-sm font-semibold text-foreground mb-4">
									{t("codeReview:issues.title")}
								</h3>
								<div className="space-y-3">
									{result.issues.map((issue, idx) => (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
											key={idx}
											className="rounded-lg border border-border p-4 space-y-2"
										>
											<div className="flex items-start justify-between gap-3">
												<div className="flex items-center gap-2 flex-wrap">
													<SeverityBadge severity={issue.severity} />
													<span className="text-xs font-mono text-muted-foreground">
														{issue.rule}
													</span>
													{issue.file && (
														<button
															type="button"
															className="text-xs text-primary underline underline-offset-2 text-left break-all"
															onClick={() =>
																issue.file &&
																onNavigate(issue.file, issue.line || 1)
															}
														>
															{issue.file}:{issue.line || 1}
														</button>
													)}
													{issue.line && (
														<span className="text-xs text-muted-foreground">
															{t("codeReview:issues.line", {
																line: issue.line,
															})}
														</span>
													)}
												</div>
											</div>
											<p className="text-sm text-foreground">{issue.message}</p>
											{issue.suggestion && (
												<div className="rounded-md bg-secondary/50 p-3 text-xs text-muted-foreground">
													<span className="font-medium text-foreground">
														{t("codeReview:issues.suggestion")}:{" "}
													</span>
													{issue.suggestion}
												</div>
											)}
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					)}
				</div>
			)}
		</div>
	);
}
