import { Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CliToolId, CLI_TOOL_NAMES } from "./cli-tool-order";
import { Button } from "./ui/button";

/**
 * What a badge of the « Outils CLI » panel tells the panel about its update:
 * the badge's own one-click update (the very function its « Mise à jour »
 * button runs), and whether it is running. Reported only while a newer
 * release is known to be out, or while the update runs.
 */
export interface CliUpdateOffer {
	readonly run: () => Promise<unknown>;
	readonly isUpdating: boolean;
}

export type CliUpdateReporter = (offer: CliUpdateOffer | null) => void;

/**
 * Tells the panel whether this badge has an update to run. `run` may change
 * at every render: the panel always calls the latest one, so a badge does not
 * have to memoize its handler.
 */
export function useReportCliUpdate(
	onUpdateChange: CliUpdateReporter | undefined,
	available: boolean,
	isUpdating: boolean,
	run: () => Promise<unknown>,
): void {
	const runRef = useRef(run);
	useEffect(() => {
		runRef.current = run;
	});
	useEffect(() => {
		if (!onUpdateChange) return;
		onUpdateChange(
			available || isUpdating ? { run: () => runRef.current(), isUpdating } : null,
		);
	}, [onUpdateChange, available, isUpdating]);
	useEffect(() => () => onUpdateChange?.(null), [onUpdateChange]);
}

export type CliUpdateOffers = Readonly<Partial<Record<CliToolId, CliUpdateOffer>>>;

/** The CLIs whose update is still to run, in the panel's order. */
export function pendingCliUpdates(
	order: readonly CliToolId[],
	offers: CliUpdateOffers,
): CliToolId[] {
	return order.filter((id) => offers[id] && !offers[id]?.isUpdating);
}

/**
 * Runs each update one after the other: two package managers writing the
 * same global folder at once can break both installs, and one at a time
 * lets each row show its own spinner. A failure does not stop the others:
 * that row keeps its « Mise à jour » chip and its popover says why.
 */
export async function runCliUpdatesInTurn(
	ids: readonly CliToolId[],
	offerOf: (id: CliToolId) => CliUpdateOffer | undefined,
	onStep: (index: number) => void,
): Promise<void> {
	for (const [index, id] of ids.entries()) {
		onStep(index);
		try {
			await offerOf(id)?.run();
		} catch {
			// The badge shows its own error.
		}
	}
}

/**
 * The panel's foot: « Tout mettre à jour (3) » when at least one CLI has a
 * newer release, « Mise à jour 2/3… » while they run, nothing otherwise.
 */
export function CliUpdateAllButton({
	order,
	offers,
}: {
	readonly order: readonly CliToolId[];
	readonly offers: CliUpdateOffers;
}) {
	const { t } = useTranslation("navigation");
	const offersRef = useRef(offers);
	useEffect(() => {
		offersRef.current = offers;
	});
	const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
	const pending = pendingCliUpdates(order, offers);

	const updateAll = useCallback(async () => {
		const ids = pendingCliUpdates(order, offersRef.current);
		if (ids.length === 0) return;
		setProgress({ current: 1, total: ids.length });
		try {
			await runCliUpdatesInTurn(
				ids,
				(id) => offersRef.current[id],
				(index) => setProgress({ current: index + 1, total: ids.length }),
			);
		} finally {
			setProgress(null);
		}
	}, [order]);

	if (!progress && pending.length === 0) return null;

	const names = pending.map((id) => CLI_TOOL_NAMES[id]).join(", ");
	const label = progress
		? t("cliTools.updatingAll", { current: progress.current, total: progress.total })
		: t("cliTools.updateAll", { count: pending.length });

	return (
		<div className="mt-1 border-t border-border/60 pt-1">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				data-testid="cli-update-all"
				className="h-7 w-full justify-center gap-1.5 text-xs text-warning hover:text-warning"
				disabled={progress !== null}
				title={progress ? label : t("cliTools.updateAllTooltip", { names })}
				onClick={() => {
					void updateAll();
				}}
			>
				{progress ? (
					<Loader2 className="h-3 w-3 animate-spin" />
				) : (
					<Download className="h-3 w-3" />
				)}
				<span className="tabular-nums">{label}</span>
			</Button>
		</div>
	);
}
