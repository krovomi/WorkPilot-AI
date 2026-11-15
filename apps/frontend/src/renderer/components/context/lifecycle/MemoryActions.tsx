import { History, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryJournalEntry } from "../../../../shared/types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { errorLabel } from "./lifecycle-labels";
import { MemoryTimeline } from "./MemoryTimeline";

interface MemoryActionsProps {
	readonly projectId: string;
	/** The memory's vault path. */
	readonly memoryId: string;
	readonly pinned: boolean;
	/** After a pin or a forget: the list is read again. */
	readonly onChanged: () => void;
}

/** Pin, forget (restorable) and the timeline of one memory. */
export function MemoryActions({
	projectId,
	memoryId,
	pinned,
	onChanged,
}: MemoryActionsProps) {
	const { t } = useTranslation(["context"]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [reason, setReason] = useState("");
	const [history, setHistory] = useState<MemoryJournalEntry[] | null>(null);

	const run = async (action: () => Promise<{ success: boolean; error?: string }>) => {
		setBusy(true);
		setError(null);
		try {
			const result = await action();
			if (result.success) {
				onChanged();
				return true;
			}
			setError(errorLabel(t, result.error));
		} catch {
			setError(errorLabel(t, undefined));
		} finally {
			setBusy(false);
		}
		return false;
	};

	const togglePin = () =>
		run(() => window.electronAPI.pinMemory(projectId, memoryId, !pinned));

	const forget = async () => {
		if (await run(() => window.electronAPI.forgetMemory(projectId, memoryId, reason))) {
			setConfirming(false);
			setReason("");
		}
	};

	const toggleHistory = async () => {
		if (history) {
			setHistory(null);
			return;
		}
		const result = await window.electronAPI.getMemoryHistory(projectId, memoryId);
		if (result.success) setHistory(result.data ?? []);
		else setError(errorLabel(t, result.error));
	};

	return (
		<div className="mt-3 space-y-2" data-testid="memory-actions">
			<div className="flex flex-wrap items-center gap-2">
				{pinned && (
					<Badge variant="outline" className="text-xs">
						<Pin className="h-3 w-3 mr-1" />
						{t("context:lifecycle.actions.pinnedBadge")}
					</Badge>
				)}
				<Button variant="ghost" size="sm" className="h-7 gap-1" disabled={busy} onClick={togglePin}>
					{pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
					{pinned ? t("context:lifecycle.actions.unpin") : t("context:lifecycle.actions.pin")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1"
					disabled={busy}
					onClick={() => setConfirming((value) => !value)}
				>
					<Trash2 className="h-3.5 w-3.5" />
					{t("context:lifecycle.actions.forget")}
				</Button>
				<Button variant="ghost" size="sm" className="h-7 gap-1" onClick={toggleHistory}>
					<History className="h-3.5 w-3.5" />
					{history ? t("context:lifecycle.actions.hideHistory") : t("context:lifecycle.actions.history")}
				</Button>
			</div>
			{confirming && (
				<div className="flex gap-2">
					<Input
						value={reason}
						maxLength={300}
						placeholder={t("context:lifecycle.actions.forgetReason")}
						aria-label={t("context:lifecycle.actions.forgetReason")}
						onChange={(event) => setReason(event.target.value)}
					/>
					<Button size="sm" variant="destructive" disabled={busy} onClick={forget}>
						{t("context:lifecycle.actions.confirmForget")}
					</Button>
				</div>
			)}
			{confirming && (
				<p className="text-xs text-muted-foreground">
					{t("context:lifecycle.actions.forgetHint")}
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			{history && <MemoryTimeline entries={history} />}
		</div>
	);
}
