/**
 * The download affordance for a phase's local model.
 *
 * It sits next to the model `<Select>` rather than inside it, because the
 * problem it solves is the model that is *already selected* and still missing:
 * re-picking the value a `<Select>` already holds fires no change event, so a
 * download hidden behind `onValueChange` was unreachable exactly when it was
 * needed. Here the state of the selected model is always visible — missing,
 * downloading with its percentage, ready, or failed with a retry — and one
 * click starts, or stops, the pull.
 *
 * Nothing here blocks: the pull runs in the main process, the phase can be left
 * and reopened, and the global indicator carries the same progress everywhere
 * in the app.
 */

import { AlertCircle, Check, Download, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import type { DownloadProgress } from "../../stores/download-store";

interface ModelDownloadChipProps {
	/** The model the phase will run. */
	model: string;
	/** Whether the local server already has it. `undefined` = not yet known. */
	installed?: boolean;
	/** This model's entry in the shared download store, if any. */
	download?: DownloadProgress;
	onDownload: () => void;
	onCancel: () => void;
	onDismiss: () => void;
	className?: string;
}

const CHIP_BASE =
	"flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] " +
	"font-medium transition-colors focus-visible:outline-none " +
	"focus-visible:ring-1 focus-visible:ring-primary/50";

export function ModelDownloadChip({
	model,
	installed,
	download,
	onDownload,
	onCancel,
	onDismiss,
	className,
}: ModelDownloadChipProps) {
	const { t } = useTranslation(["tasks"]);
	const status = download?.status;

	if (status === "starting" || status === "downloading") {
		const pct = Math.round(download?.percentage ?? 0);
		return (
			<span
				className={cn(
					CHIP_BASE,
					"border-primary/40 bg-primary/10 text-primary",
					className,
				)}
				title={[
					t("tasks:logs.model.downloadingTip", "Téléchargement de « {{model}} »", {
						model,
					}),
					download?.speed,
					download?.timeRemaining,
				]
					.filter(Boolean)
					.join(" · ")}
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				{/* A thin bar rather than a number alone: at 4 GB the percentage
				    barely moves, and a bar that has visibly advanced since the last
				    look is the difference between "slow" and "stuck". */}
				<span className="relative h-1 w-10 overflow-hidden rounded-full bg-primary/20">
					{pct > 0 ? (
						<span
							className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-500"
							style={{ width: `${pct}%` }}
						/>
					) : (
						<span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-indeterminate" />
					)}
				</span>
				<span className="tabular-nums">
					{pct > 0 ? `${pct}%` : t("tasks:logs.model.downloadQueued", "…")}
				</span>
				<button
					type="button"
					onClick={onCancel}
					className="rounded-full p-0.5 hover:bg-primary/20"
					aria-label={t(
						"tasks:logs.model.cancelDownload",
						"Annuler le téléchargement",
					)}
					title={t("tasks:logs.model.cancelDownload", "Annuler le téléchargement")}
				>
					<X className="h-2.5 w-2.5" />
				</button>
			</span>
		);
	}

	if (status === "failed") {
		return (
			<button
				type="button"
				onClick={onDownload}
				className={cn(
					CHIP_BASE,
					"border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
					className,
				)}
				title={
					download?.error ||
					t("tasks:logs.model.retryDownload", "Relancer le téléchargement")
				}
			>
				<AlertCircle className="h-3 w-3" />
				{t("tasks:logs.model.retryDownload", "Relancer le téléchargement")}
			</button>
		);
	}

	// A freshly finished download stays visible until dismissed: the point of
	// leaving the panel while it runs is to come back and find the answer.
	if (status === "completed" && installed !== true) {
		return (
			<button
				type="button"
				onClick={onDismiss}
				className={cn(
					CHIP_BASE,
					"border-success/40 bg-success/10 text-success hover:bg-success/20",
					className,
				)}
				title={t("tasks:logs.model.downloadDoneDesc", "{{model}} est prêt.", {
					model,
				})}
			>
				<Check className="h-3 w-3" />
				{t("tasks:logs.model.ready", "Prêt")}
			</button>
		);
	}

	// Installed, or the catalog has not said yet — nothing to offer.
	if (installed !== false) return null;

	return (
		<button
			type="button"
			onClick={onDownload}
			className={cn(
				CHIP_BASE,
				"border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20",
				className,
			)}
			title={t(
				"tasks:logs.model.downloadTip",
				"« {{model}} » n'est pas installé sur le serveur local. Le téléchargement se fait en arrière-plan : vous pouvez continuer à travailler.",
				{ model },
			)}
		>
			<Download className="h-3 w-3" />
			{t("tasks:logs.model.download", "Télécharger")}
		</button>
	);
}
