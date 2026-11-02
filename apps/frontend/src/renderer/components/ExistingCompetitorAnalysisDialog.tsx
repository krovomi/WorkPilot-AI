import { CheckCircle, Globe, RefreshCw, TrendingUp } from "lucide-react";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { useTranslation } from "react-i18next";
import { formatAppDate } from "@/lib/date-format";

interface ExistingCompetitorAnalysisDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUseExisting: () => void;
	onRunNew: () => void;
	onSkip: () => void;
	analysisDate?: Date;
}

export function ExistingCompetitorAnalysisDialog({
	open,
	onOpenChange,
	onUseExisting,
	onRunNew,
	onSkip,
	analysisDate,
}: ExistingCompetitorAnalysisDialogProps) {
	const { t } = useTranslation();
	const handleUseExisting = () => {
		onUseExisting();
		onOpenChange(false);
	};

	const handleRunNew = () => {
		onRunNew();
		onOpenChange(false);
	};

	const handleSkip = () => {
		onSkip();
		onOpenChange(false);
	};

	const formatDate = (date?: Date) => {
		if (!date) return "recently";
		return formatAppDate(date, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="sm:max-w-[500px]">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2 text-foreground">
						<TrendingUp className="h-5 w-5 text-primary" />
						{t("roadmap:competitorAnalysis.optionsTitle")}
					</AlertDialogTitle>
					<AlertDialogDescription className="text-muted-foreground">
						{t("roadmap:competitorAnalysis.existingFrom")}{" "}
						{formatDate(analysisDate)}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="py-4 space-y-3">
					{/* Option 1: Use existing (recommended) */}
					<button
						type="button"
						onClick={handleUseExisting}
						className="w-full rounded-lg bg-primary/10 border border-primary/30 p-4 text-left hover:bg-primary/20 transition-colors"
					>
						<div className="flex items-start gap-3">
							<CheckCircle className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
							<div className="flex-1">
								<h4 className="text-sm font-medium text-foreground flex items-center gap-2">
									{t("roadmap:competitorAnalysis.useExisting")}
									<span className="text-xs text-primary font-normal">
										{t("roadmap:competitorAnalysis.recommended")}
									</span>
								</h4>
								<p className="text-xs text-muted-foreground mt-1">
									{t("roadmap:competitorAnalysis.useExistingDescription")}
								</p>
							</div>
						</div>
					</button>

					{/* Option 2: Run new analysis */}
					<button
						type="button"
						onClick={handleRunNew}
						className="w-full rounded-lg bg-muted/50 border border-border p-4 text-left hover:bg-muted transition-colors"
					>
						<div className="flex items-start gap-3">
							<RefreshCw className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
							<div className="flex-1">
								<h4 className="text-sm font-medium text-foreground">
									{t("roadmap:competitorAnalysis.runNew")}
								</h4>
								<p className="text-xs text-muted-foreground mt-1">
									{t("roadmap:competitorAnalysis.runNewDescription")}
								</p>
							</div>
						</div>
					</button>

					{/* Option 3: Skip */}
					<button
						type="button"
						onClick={handleSkip}
						className="w-full rounded-lg bg-muted/30 border border-border/50 p-4 text-left hover:bg-muted/50 transition-colors"
					>
						<div className="flex items-start gap-3">
							<Globe className="h-5 w-5 text-muted-foreground/60 flex-shrink-0 mt-0.5" />
							<div className="flex-1">
								<h4 className="text-sm font-medium text-muted-foreground">
									{t("roadmap:competitorAnalysis.skip")}
								</h4>
								<p className="text-xs text-muted-foreground/80 mt-1">
									{t("roadmap:competitorAnalysis.skipDescription")}
								</p>
							</div>
						</div>
					</button>
				</div>

				<AlertDialogFooter className="sm:justify-start">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t("common:buttons.cancel")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
