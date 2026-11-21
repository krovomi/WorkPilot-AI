import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronUp,
	Download,
	Loader2,
	RotateCw,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { formatDownloadRemaining } from "../lib/download-remaining";
import { cn } from "../lib/utils";
import { useOllamaModelDownload } from "../hooks/useOllamaModelDownload";
import { useDownloadStore } from "../stores/download-store";

/**
 * GlobalDownloadIndicator Component
 *
 * A floating indicator that shows active Ollama model downloads.
 * Appears in the bottom-right corner when downloads are in progress.
 * Can be expanded to show details or minimized to just show count.
 */
export function GlobalDownloadIndicator() {
	const { t } = useTranslation("common");
	const downloads = useDownloadStore((state) => state.downloads);
	const clearDownload = useDownloadStore((state) => state.clearDownload);
	// `retry` is the same "pull this model" call the phase selector uses; the
	// row variable below is already named `download`, so it is aliased here.
	const { download: retry, cancel } = useOllamaModelDownload();
	const [isExpanded, setIsExpanded] = useState(true);

	const allDownloads = Object.values(downloads);
	const activeDownloads = allDownloads.filter(
		(d) => d.status === "starting" || d.status === "downloading",
	);
	const completedDownloads = allDownloads.filter(
		(d) => d.status === "completed",
	);
	const failedDownloads = allDownloads.filter((d) => d.status === "failed");

	// Don't render if no downloads
	if (allDownloads.length === 0) {
		return null;
	}

	const hasActive = activeDownloads.length > 0;

	// One state drives both the icon and the words, so a failure is never
	// announced as "complete" next to a red icon.
	const { icon: statusIcon, text: statusText } = describeDownloads(
		activeDownloads.length,
		completedDownloads.length,
		failedDownloads.length,
		t,
	);

	// Determine button background color based on active state
	const buttonBgClass = hasActive ? "bg-primary/10" : "bg-muted/50";

	return (
		<div className="fixed bottom-4 right-4 z-50 max-w-sm">
			<div className="rounded-lg border border-border bg-card shadow-lg overflow-hidden">
				{/* Header: the toggle and "clear all" are siblings, never nested buttons */}
				<div className={cn("flex items-center", buttonBgClass)}>
					<button
						type="button"
						className="flex flex-1 items-center justify-between gap-2 px-3 py-2 cursor-pointer text-left"
						onClick={() => setIsExpanded(!isExpanded)}
						aria-expanded={isExpanded}
						aria-label={t("downloads.toggleExpand")}
					>
						<span className="flex items-center gap-2">
							{statusIcon}
							<span className="text-sm font-medium">{statusText}</span>
						</span>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4 text-muted-foreground" />
						) : (
							<ChevronUp className="h-4 w-4 text-muted-foreground" />
						)}
					</button>
					{!hasActive && (
						<button
							type="button"
							onClick={() => {
								// Clear all completed/failed/cancelled downloads
								for (const d of allDownloads) clearDownload(d.modelName);
							}}
							className="mr-2 p-1 hover:bg-muted rounded"
							aria-label={t("downloads.clearAll")}
						>
							<X className="h-3.5 w-3.5 text-muted-foreground" />
						</button>
					)}
				</div>

				{/* Download list (expanded) */}
				{isExpanded && (
					<div className="divide-y divide-border">
						{allDownloads.map((download) => (
							<div key={download.modelName} className="px-3 py-2 space-y-1.5">
								<div className="flex items-center justify-between">
									<span className="text-xs font-medium truncate max-w-[200px]">
										{download.modelName}
									</span>
									<div className="flex items-center gap-1.5">
										{download.status === "completed" && (
											<span className="text-xs text-success flex items-center gap-1">
												<Check className="h-3 w-3" />
												{t("downloads.done")}
											</span>
										)}
										{download.status === "failed" && (
											<span className="text-xs text-destructive flex items-center gap-1">
												<AlertCircle className="h-3 w-3" />
												{t("downloads.failedLabel")}
											</span>
										)}
										{download.status === "cancelled" && (
											<span className="text-xs text-muted-foreground">
												{t("downloads.cancelledLabel")}
											</span>
										)}
										{download.status === "failed" && (
											<button
												type="button"
												onClick={() => void retry(download.modelName)}
												className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
												aria-label={t("downloads.retry")}
												title={t("downloads.retry")}
											>
												<RotateCw className="h-3 w-3" />
											</button>
										)}
										{(download.status === "starting" ||
											download.status === "downloading") && (
											<>
												<span className="text-xs text-muted-foreground">
													{download.percentage > 0
														? `${Math.round(download.percentage)}%`
														: t("downloads.starting")}
												</span>
												<button
													type="button"
													onClick={() => cancel(download.modelName)}
													className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
													aria-label={t("downloads.cancel")}
													title={t("downloads.cancel")}
												>
													<X className="h-3 w-3" />
												</button>
											</>
										)}
									</div>
								</div>

								{/* Progress bar for active downloads */}
								{(download.status === "starting" ||
									download.status === "downloading") && (
									<>
										<div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
											{download.percentage > 0 ? (
												<div
													className="h-full rounded-full bg-primary transition-all duration-300"
													style={{ width: `${download.percentage}%` }}
												/>
											) : (
												<div className="h-full w-1/4 rounded-full bg-primary animate-indeterminate" />
											)}
										</div>
										{(download.speed || download.secondsRemaining) && (
											<div className="flex items-center justify-between text-3xs text-muted-foreground">
												<span>{download.speed}</span>
												{download.secondsRemaining ? (
													<span className="text-primary">
														{formatDownloadRemaining(download.secondsRemaining, t)}
													</span>
												) : null}
											</div>
										)}
									</>
								)}

								{/* Error message for failed downloads */}
								{download.status === "failed" && download.error && (
									<p className="text-3xs text-destructive/80 truncate">
										{download.error}
									</p>
								)}
							</div>
						))}
						{hasActive && (
							<p className="px-3 py-2 text-3xs text-muted-foreground">
								{t("downloads.hint")}
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/** Icon and header words for the whole set of downloads. */
function describeDownloads(
	active: number,
	completed: number,
	failed: number,
	t: TFunction,
): { icon: ReactNode; text: string } {
	if (active > 0) {
		return {
			icon: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
			text: t("downloads.downloading", { count: active }),
		};
	}
	if (failed > 0) {
		return {
			icon: <AlertCircle className="h-4 w-4 text-destructive" />,
			text: t("downloads.failed", { count: failed }),
		};
	}
	if (completed > 0) {
		return {
			icon: <Check className="h-4 w-4 text-success" />,
			text: t("downloads.complete", { count: completed }),
		};
	}
	return {
		icon: <Download className="h-4 w-4 text-muted-foreground" />,
		text: t("downloads.cancelledLabel"),
	};
}

