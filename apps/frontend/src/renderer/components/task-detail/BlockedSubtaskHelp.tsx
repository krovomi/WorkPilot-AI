import {
	AlertTriangle,
	Check,
	Loader2,
	Reply,
	RotateCcw,
	SkipForward,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Subtask } from "../../../shared/types";
import {
	MAX_REPLY,
	type UnblockAction,
} from "../../../shared/utils/subtask-unblock";
import { useToast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { unblockSubtask } from "../../stores/subtask-unblock-actions";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** Refusal codes the main process and the server send back. */
const KNOWN_ERRORS = new Set([
	"invalid_action",
	"reply_required",
	"reply_too_long",
	"subtask_not_found",
	"not_blocked",
	"task_running",
	"task_not_found",
	"plan_unreadable",
]);

interface BlockedSubtaskHelpProps {
	readonly taskId: string;
	readonly subtask: Subtask;
}

/**
 * What a blocked (or failed) subtask needs from the person, and the four
 * answers that unblock it: it is done, try again, reply to the agent, it is
 * not needed. A retry or a reply restarts the build.
 */
export function BlockedSubtaskHelp({ taskId, subtask }: BlockedSubtaskHelpProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [replyOpen, setReplyOpen] = useState(false);
	const [reply, setReply] = useState("");
	const [pending, setPending] = useState<UnblockAction | null>(null);

	const failed = subtask.status === "failed";
	const kind = failed ? "failed" : (subtask.blockedKind ?? "agent");
	// The loop's own manual-check block has a fixed English reason: say it in
	// the app's language. Every other reason is the agent's, shown as written.
	const reason =
		kind === "manual_verification"
			? t("tasks:subtasks.unblock.manualReason")
			: subtask.blockedReason;

	const send = async (action: UnblockAction) => {
		setPending(action);
		try {
			const result = await unblockSubtask(
				taskId,
				subtask.id,
				action,
				action === "answer" ? reply : undefined,
			);
			if (result.success) {
				toast({
					title: t(`tasks:subtasks.unblock.done.${action}`),
					description: result.restarted
						? t("tasks:subtasks.unblock.restarted")
						: undefined,
					duration: 4000,
				});
				setReplyOpen(false);
				setReply("");
				return;
			}
			const code = result.error ?? "";
			toast({
				title: t("tasks:subtasks.unblock.errorTitle"),
				description: KNOWN_ERRORS.has(code)
					? t(`tasks:subtasks.unblock.errors.${code}`)
					: code || t("tasks:subtasks.unblock.errors.generic"),
				variant: "destructive",
			});
		} finally {
			setPending(null);
		}
	};

	const busy = pending !== null;
	const icon = (action: UnblockAction, Icon: typeof Check) =>
		pending === action ? (
			<Loader2 className="h-3 w-3 animate-spin" />
		) : (
			<Icon className="h-3 w-3" />
		);

	return (
		<section
			aria-label={t("tasks:subtasks.unblock.regionLabel")}
			className={cn(
				"rounded-lg border px-3 py-2.5 space-y-2",
				failed
					? "border-[var(--error)]/40 bg-[var(--error-light)]"
					: "border-warning/40 bg-warning/10",
			)}
		>
			<div
				className={cn(
					"flex items-center gap-1.5 text-xs font-medium",
					failed ? "text-[var(--error)]" : "text-warning",
				)}
			>
				{failed ? (
					<XCircle className="h-3.5 w-3.5 flex-shrink-0" />
				) : (
					<AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
				)}
				<span>{t(`tasks:subtasks.unblock.title.${kind}`)}</span>
			</div>

			<p className="text-xs text-foreground">
				{reason
					? t("tasks:subtasks.unblock.why", { reason })
					: t("tasks:subtasks.unblock.noReason")}
			</p>
			<p className="text-2xs text-muted-foreground">
				{t(`tasks:subtasks.unblock.hint.${kind}`)}
			</p>

			{subtask.humanReply && (
				<p className="text-2xs text-muted-foreground">
					{t("tasks:subtasks.unblock.lastReply", { reply: subtask.humanReply })}
				</p>
			)}

			<div className="flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="success"
					className="h-7 gap-1 px-2.5 text-xs"
					disabled={busy}
					onClick={() => send("complete")}
				>
					{icon("complete", Check)}
					{t("tasks:subtasks.unblock.actions.complete")}
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="h-7 gap-1 px-2.5 text-xs"
					disabled={busy}
					onClick={() => send("retry")}
				>
					{icon("retry", RotateCcw)}
					{t("tasks:subtasks.unblock.actions.retry")}
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="h-7 gap-1 px-2.5 text-xs"
					disabled={busy}
					aria-expanded={replyOpen}
					onClick={() => setReplyOpen((open) => !open)}
				>
					<Reply className="h-3 w-3" />
					{t("tasks:subtasks.unblock.actions.answer")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 gap-1 px-2.5 text-xs text-muted-foreground"
					disabled={busy}
					onClick={() => send("skip")}
				>
					{icon("skip", SkipForward)}
					{t("tasks:subtasks.unblock.actions.skip")}
				</Button>
			</div>

			{replyOpen && (
				<div className="space-y-1.5">
					<Textarea
						value={reply}
						onChange={(e) => setReply(e.target.value)}
						placeholder={t("tasks:subtasks.unblock.replyPlaceholder")}
						aria-label={t("tasks:subtasks.unblock.replyLabel")}
						maxLength={MAX_REPLY}
						rows={3}
						className="w-full resize-y text-xs"
					/>
					<div className="flex items-center justify-end gap-1.5">
						<Button
							size="sm"
							variant="ghost"
							className="h-7 px-2.5 text-xs"
							disabled={busy}
							onClick={() => {
								setReplyOpen(false);
								setReply("");
							}}
						>
							{t("tasks:subtasks.unblock.cancel")}
						</Button>
						<Button
							size="sm"
							className="h-7 gap-1 px-2.5 text-xs"
							disabled={busy || !reply.trim()}
							onClick={() => send("answer")}
						>
							{icon("answer", Reply)}
							{t("tasks:subtasks.unblock.sendReply")}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}

/** One line under a subtask the person resolved themselves. */
export function HumanResolutionNote({ subtask }: { readonly subtask: Subtask }) {
	const { t } = useTranslation(["tasks"]);
	if (!subtask.humanResolution) return null;
	return (
		<p className="mt-1 text-2xs text-muted-foreground">
			{t(`tasks:subtasks.unblock.resolved.${subtask.humanResolution.action}`)}
		</p>
	);
}
