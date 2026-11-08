import { Check, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CliUpdateResult,
	CliUpdateStatus,
	UpdatableCliTool,
} from "../../shared/types/cli-update";
import { Button } from "./ui/button";

export interface CliUpdateState {
	/** The last check: installed version, latest published, outdated or not. */
	readonly info: CliUpdateStatus | null;
	readonly isUpdating: boolean;
	/** What went wrong with the last update, translated, with the command output. */
	readonly error: string | null;
	/** The version the last successful update left, for its confirmation line. */
	readonly updatedTo: string | null;
	readonly check: () => Promise<void>;
	readonly update: () => Promise<void>;
}

/**
 * The update side of a CLI badge: whether a newer release is published and
 * the one-click update. Checked once the badge knows the CLI is installed, so
 * a missing CLI costs no registry lookup; `onUpdated` lets the badge re-read
 * its own status once the update ran.
 */
export function useCliUpdate(
	tool: UpdatableCliTool,
	name: string,
	enabled: boolean,
	onUpdated?: () => void,
): CliUpdateState {
	const { t } = useTranslation(["navigation"]);
	const [info, setInfo] = useState<CliUpdateStatus | null>(null);
	const [isUpdating, setIsUpdating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [updatedTo, setUpdatedTo] = useState<string | null>(null);

	const check = useCallback(async () => {
		const run = globalThis.electronAPI?.checkCliUpdate;
		if (!run) return;
		try {
			setInfo(await run(tool));
		} catch {
			setInfo(null);
		}
	}, [tool]);

	useEffect(() => {
		if (enabled) void check();
		else setInfo(null);
	}, [enabled, check]);

	const update = useCallback(async () => {
		const run = globalThis.electronAPI?.updateCli;
		if (!run) return;
		setIsUpdating(true);
		setError(null);
		setUpdatedTo(null);
		let answer: CliUpdateResult;
		try {
			answer = await run(tool);
		} catch (err) {
			answer = {
				tool,
				success: false,
				error: "failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		} finally {
			setIsUpdating(false);
		}
		if (answer.status) setInfo(answer.status);
		if (answer.success) {
			setUpdatedTo(answer.status?.version ?? "");
		} else {
			const message = t(`navigation:agentCli.update.error.${answer.error ?? "failed"}`, {
				name,
				version: answer.status?.version ?? "?",
				latest: answer.status?.latest ?? "?",
			});
			setError(answer.detail ? `${message}\n${answer.detail}` : message);
		}
		onUpdated?.();
	}, [tool, name, t, onUpdated]);

	return { info, isUpdating, error, updatedTo, check, update };
}

/**
 * The popover's update block: installed and latest versions, the button, and
 * what the last update said. The button shows when a newer release is out,
 * and also when the latest release cannot be known (Antigravity publishes
 * none, or the registry did not answer): the CLI's own updater then decides.
 */
export function CliUpdateSection({
	state,
	name,
}: {
	readonly state: CliUpdateState;
	readonly name: string;
}) {
	const { t } = useTranslation(["common", "navigation"]);
	const { info, isUpdating, error, updatedTo } = state;
	if (!info?.installed) return null;
	const latestUnknown = !info.latest;
	const showButton = info.isOutdated || latestUnknown || isUpdating;

	return (
		<div className="space-y-2">
			<div className="text-xs space-y-1 p-2 bg-muted rounded-md">
				<div className="flex justify-between">
					<span className="text-muted-foreground">{t("navigation:agentCli.version")}:</span>
					<span className="font-mono">{info.version ?? t("navigation:agentCli.update.unknown")}</span>
				</div>
				<div className="flex justify-between">
					<span className="text-muted-foreground">{t("navigation:agentCli.update.latest")}:</span>
					<span className={info.isOutdated ? "font-mono text-warning" : "font-mono"}>
						{info.latest ?? t("navigation:agentCli.update.unknown")}
					</span>
				</div>
			</div>

			{showButton && (
				<Button
					size="sm"
					variant={info.isOutdated ? "default" : "outline"}
					className="w-full gap-1"
					onClick={() => {
						void state.update();
					}}
					disabled={isUpdating}
				>
					{isUpdating ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<Download className="h-3 w-3" />
					)}
					{isUpdating
						? t("navigation:agentCli.update.updating")
						: info.isOutdated
							? t("common:update")
							: t("navigation:agentCli.update.checkAndUpdate")}
				</Button>
			)}

			{updatedTo !== null && !error && (
				<p className="text-xs text-success flex items-center gap-1">
					<Check className="h-3 w-3" />
					{updatedTo
						? t("navigation:agentCli.update.doneWithVersion", { name, version: updatedTo })
						: t("navigation:agentCli.update.done", { name })}
				</p>
			)}

			{error && (
				<p
					role="alert"
					className="text-xs text-destructive whitespace-pre-wrap break-words max-h-32 overflow-auto"
				>
					{error}
				</p>
			)}
		</div>
	);
}

/** The compact « Mise à jour » chip of a sidebar row whose CLI is outdated. */
export function CliUpdateChip({ isUpdating }: { readonly isUpdating: boolean }) {
	const { t } = useTranslation(["common", "navigation"]);
	return (
		<span className="ml-auto text-3xs bg-warning/20 text-warning px-1.5 py-0.5 rounded flex items-center gap-1">
			{isUpdating && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
			{isUpdating ? t("navigation:agentCli.update.updatingShort") : t("common:update")}
		</span>
	);
}
