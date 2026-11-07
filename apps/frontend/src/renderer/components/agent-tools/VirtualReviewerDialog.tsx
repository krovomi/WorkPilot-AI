import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	type VirtualReviewSummaryPayload,
	fetchVirtualReviewSummary,
	runVirtualReview,
} from "../../lib/agent-tools-api";
import { useTranslation } from "react-i18next";

export interface VirtualReviewerDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly projectDir: string;
	readonly specDir: string;
	/** Called after the reviewer wrote virtual_review.md, with its absolute path. */
	readonly onReviewWritten?: (path: string) => void;
}

export function VirtualReviewerDialog({
	open,
	onOpenChange,
	projectDir,
	specDir,
	onReviewWritten,
}: VirtualReviewerDialogProps) {
	const { t } = useTranslation();
	const [summary, setSummary] = useState<VirtualReviewSummaryPayload | null>(
		null,
	);
	const [enabled, setEnabled] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [writtenPath, setWrittenPath] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setSummary(null);
			setError(null);
			setWrittenPath(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchVirtualReviewSummary(specDir, projectDir, controller.signal)
			.then((res) => {
				if (res.ok) {
					setSummary(res.data.summary);
					setEnabled(res.data.enabled);
				} else if (res.error !== "aborted") {
					setError(res.error);
				}
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, projectDir, specDir]);

	const handleRun = async () => {
		setRunning(true);
		setError(null);
		const res = await runVirtualReview(specDir, projectDir);
		setRunning(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		setWrittenPath(res.data.written_to);
		onReviewWritten?.(res.data.written_to);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("agentTools:virtualReviewer.title")}</DialogTitle>
					<DialogDescription>
						<strong>{t("agentTools:virtualReviewer.disclaimer")}</strong>{" "}
						{t("agentTools:virtualReviewer.writesBefore")} <code className="text-xs">virtual_review.md</code> {t("agentTools:virtualReviewer.writesAfter")}{" "}
						<code className="text-xs">
							WORKPILOT_VIRTUAL_REVIEWER_ENABLED
						</code>
						.
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						{t("agentTools:virtualReviewer.loading")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive ">
						{error}
					</div>
				)}

				{summary && (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2 text-xs">
							{enabled ? (
								<Badge className="bg-success/15 text-success ">
									{t("agentTools:virtualReviewer.enabled")}
								</Badge>
							) : (
								<Badge className="bg-slate-500/15 text-slate-700 dark:text-slate-300">
									{t("agentTools:virtualReviewer.disabled")}
								</Badge>
							)}
							<Badge variant="outline">
								{t("agentTools:virtualReviewer.chars", {
									label: "spec",
									count: summary.spec_chars,
								})}
							</Badge>
							<Badge variant="outline">
								{t("agentTools:virtualReviewer.chars", {
									label: "qa_report",
									count: summary.qa_report_chars,
								})}
							</Badge>
							{summary.self_review_present && (
								<Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">
									{t("agentTools:virtualReviewer.selfReviewPresent")}
								</Badge>
							)}
							{summary.diff_truncated && (
								<Badge className="bg-warning/15 text-warning ">
									{t("agentTools:virtualReviewer.diffTruncated")}
								</Badge>
							)}
						</div>

						{summary.error && (
							<div className="text-xs text-warning ">
								⚠ {summary.error}
							</div>
						)}

						{writtenPath && (
							<div className="rounded-md bg-success/10 p-3 text-sm">
								<div className="font-medium text-success ">
									{t("agentTools:virtualReviewer.written")}
								</div>
								<code className="text-xs text-muted-foreground break-all">
									{writtenPath}
								</code>
							</div>
						)}

						<div className="text-xs text-muted-foreground">
							{t("agentTools:virtualReviewer.stubNotice")}
						</div>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:buttons.close")}
					</Button>
					<Button disabled={!enabled || running} onClick={handleRun}>
						{running ? t("agentTools:virtualReviewer.running") : t("agentTools:virtualReviewer.run")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
