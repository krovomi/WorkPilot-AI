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
	type CostEstimate,
	previewBuildCost,
} from "../../lib/agent-tools-api";
import { useTranslation } from "react-i18next";

export interface CostEstimatorDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly specDir: string;
	/** Called when the user confirms the build start. Closes the dialog. */
	readonly onConfirm: () => void;
}

const CONFIDENCE_COLORS: Record<CostEstimate["confidence"], string> = {
	high: "bg-success/15 text-success ",
	medium: "bg-warning/15 text-warning ",
	low: "bg-destructive/15 text-destructive ",
};

const formatCost = (usd: number): string => {
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `~$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
};

const formatTokens = (n: number): string =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

export function CostEstimatorDialog({
	open,
	onOpenChange,
	specDir,
	onConfirm,
}: CostEstimatorDialogProps) {
	const { t } = useTranslation();
	const [estimate, setEstimate] = useState<CostEstimate | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setEstimate(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		previewBuildCost(specDir, controller.signal)
			.then((res) => {
				if (res.ok) {
					setEstimate(res.data.estimate);
				} else if (res.error !== "aborted") {
					setError(res.error);
				}
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, specDir]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("agentTools:costDialog.title")}</DialogTitle>
					<DialogDescription>
						{t("agentTools:costDialog.descriptionBefore")}{" "}
						<code className="text-xs">{specDir.split(/[/\\]/).pop()}</code>{" "}
						{t("agentTools:costDialog.descriptionAfter")}
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{t("agentTools:costDialog.estimating")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive ">
						{t("agentTools:costDialog.unavailable", { error })}
					</div>
				)}

				{estimate && (
					<div className="space-y-4">
						<div className="flex items-center justify-between rounded-md border p-3">
							<div>
								<div className="text-xs text-muted-foreground">
									{t("agentTools:costDialog.total")}
								</div>
								<div className="text-2xl font-semibold">
									{formatCost(estimate.total_cost_usd)}
								</div>
							</div>
							<Badge className={CONFIDENCE_COLORS[estimate.confidence]}>
								{t("agentTools:costDialog.confidence", {
									level: estimate.confidence,
								})}
							</Badge>
						</div>

						<div className="space-y-2">
							{estimate.phases.map((phase) => (
								<div
									key={phase.phase}
									className="flex items-center justify-between rounded-md border p-2 text-sm"
								>
									<div>
										<div className="font-medium capitalize">{phase.phase}</div>
										<div className="text-xs text-muted-foreground">
											{phase.provider} / {phase.model}
											{phase.iterations > 1 ? ` × ${phase.iterations}` : ""}
										</div>
									</div>
									<div className="text-right">
										<div className="font-mono">
											{formatCost(phase.estimated_cost_usd)}
										</div>
										<div className="text-xs text-muted-foreground">
											{t("agentTools:costDialog.inOut", {
											input: formatTokens(phase.input_tokens),
											output: formatTokens(phase.output_tokens),
										})}
										</div>
									</div>
								</div>
							))}
						</div>

						{estimate.warnings.length > 0 && (
							<ul className="text-xs text-warning space-y-0.5">
								{estimate.warnings.map((w) => (
									<li key={w}>⚠ {w}</li>
								))}
							</ul>
						)}
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:buttons.cancel")}
					</Button>
					<Button
						disabled={loading || error !== null}
						onClick={() => {
							onConfirm();
							onOpenChange(false);
						}}
					>
						{t("agentTools:costDialog.start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
