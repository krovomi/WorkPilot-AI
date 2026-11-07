/**
 * A server card's claim, on its Kanban card (server mode): the person whose
 * work holds it. Only they act on the card; they, or a project owner, may
 * release it, and the server decides who may.
 */

import { Lock, Unlock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { useCollaborationStore } from "../../stores/collaboration-store";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface TaskLockBadgeProps {
	taskId: string;
	className?: string;
}

export function TaskLockBadge({ taskId, className }: TaskLockBadgeProps) {
	const { t } = useTranslation("collaboration");
	const lock = useCollaborationStore((s) => s.locks[taskId]);
	const me = useCollaborationStore((s) => s.me);
	const releaseLock = useCollaborationStore((s) => s.releaseLock);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!lock) return null;
	const mine = lock.userId === me?.id;
	const holder = lock.userName || t("locks.someone");
	const label = mine ? t("locks.claimedByYou") : t("locks.claimedBy", { user: holder });

	const release = async () => {
		setBusy(true);
		setError(null);
		const failure = await releaseLock(taskId);
		setBusy(false);
		if (failure) setError(failure);
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
						mine
							? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
							: "bg-warning/10 text-warning ",
						className,
					)}
					aria-label={label}
					title={label}
				>
					<Lock className="h-3 w-3" />
					<span className="max-w-24 truncate">{mine ? t("locks.you") : holder}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-64 space-y-2 p-3" side="top" onClick={(e) => e.stopPropagation()}>
				<p className="text-sm font-medium">{label}</p>
				<p className="text-xs text-muted-foreground">
					{mine ? t("locks.yourClaimHelp") : t("locks.claimHelp", { user: holder })}
				</p>
				<Button
					size="sm"
					variant={mine ? "outline" : "destructive"}
					className="w-full gap-1.5"
					disabled={busy}
					onClick={release}
				>
					<Unlock className="h-3 w-3" />
					{mine ? t("locks.release") : t("locks.forceRelease")}
				</Button>
				{error && (
					<p className="text-xs text-destructive" role="alert">
						{t("locks.releaseFailed", { reason: error })}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
