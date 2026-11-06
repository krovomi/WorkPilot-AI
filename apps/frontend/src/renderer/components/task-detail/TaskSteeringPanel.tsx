import type { SteeringMessage } from "@shared/types/steering";
import { CheckCheck, Clock, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { MAX_STEERING_CHARS } from "../../../shared/utils/steering";
import { formatAppDateTime } from "@/lib/date-format";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** How often the queue is read again while the panel is open: deliveries arrive. */
const REFRESH_MS = 10_000;

/**
 * Guider la tâche pendant qu'elle travaille (`apps/backend/foundation/steering.py`).
 *
 * Le message part dans la file de la tâche ; la prochaine session à laquelle il
 * s'applique le reçoit dans son prompt (une sous-tâche choisie, ou la suivante,
 * QA fixer compris). L'accusé « remis à la session N » est écrit par WorkPilot
 * lui-même une fois la session lancée, jamais demandé au modèle.
 */
export function TaskSteeringPanel({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const [messages, setMessages] = useState<SteeringMessage[]>([]);
	const [text, setText] = useState("");
	const [target, setTarget] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const result = await globalThis.electronAPI.listTaskSteering(task.id);
		if (result.success) setMessages(result.data ?? []);
	}, [task.id]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [load]);

	const open = task.subtasks.filter((s) => s.status !== "completed");
	const subtaskTitle = (id: string | null) =>
		task.subtasks.find((s) => s.id === id)?.title || id || "";

	const send = async () => {
		if (!text.trim()) return;
		setBusy(true);
		const result = await globalThis.electronAPI.sendTaskSteering(
			task.id,
			text,
			target || null,
		);
		setBusy(false);
		if (result.success) {
			setMessages(result.data ?? []);
			setText("");
			setError(null);
		} else {
			setError(
				t(`tasks:steering.errors.${result.error}`, {
					defaultValue: t("tasks:steering.errors.generic"),
				}),
			);
		}
	};

	return (
		<section
			className="rounded-lg border border-border p-3 space-y-2"
			aria-label={t("tasks:steering.title")}
		>
			<div>
				<h4 className="text-sm font-medium text-foreground">{t("tasks:steering.title")}</h4>
				<p className="text-xs text-muted-foreground">{t("tasks:steering.description")}</p>
			</div>

			{messages.length > 0 && (
				<ul className="space-y-1.5">
					{messages.map((message) => (
						<li key={message.id} className="text-xs rounded-md bg-muted/50 p-2 space-y-1">
							<p className="whitespace-pre-wrap text-foreground">{message.text}</p>
							<p className="flex items-center gap-1 text-muted-foreground">
								{message.deliveredAt ? (
									<>
										<CheckCheck className="h-3 w-3 text-[var(--success)]" aria-hidden />
										{t(
											message.deliveredSubtaskId
												? "tasks:steering.deliveredToSubtask"
												: "tasks:steering.delivered",
											{
												session: message.deliveredSession ?? "?",
												subtask: subtaskTitle(message.deliveredSubtaskId),
												date: formatAppDateTime(message.deliveredAt),
											},
										)}
									</>
								) : (
									<>
										<Clock className="h-3 w-3" aria-hidden />
										{message.targetSubtaskId
											? t("tasks:steering.queuedForSubtask", {
													subtask: subtaskTitle(message.targetSubtaskId),
												})
											: t("tasks:steering.queued")}
									</>
								)}
							</p>
						</li>
					))}
				</ul>
			)}

			<Textarea
				value={text}
				onChange={(event) => setText(event.target.value)}
				maxLength={MAX_STEERING_CHARS}
				rows={3}
				placeholder={t("tasks:steering.placeholder")}
				aria-label={t("tasks:steering.placeholder")}
			/>
			<div className="flex items-center justify-between gap-2">
				<select
					className="h-8 rounded-md border border-border bg-background px-2 text-xs"
					value={target}
					onChange={(event) => setTarget(event.target.value)}
					aria-label={t("tasks:steering.target")}
				>
					<option value="">{t("tasks:steering.nextSession")}</option>
					{open.map((subtask) => (
						<option key={subtask.id} value={subtask.id}>
							{subtask.title || subtask.id}
						</option>
					))}
				</select>
				<Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
					<Send className="h-3 w-3 mr-1" aria-hidden />
					{t("tasks:steering.send")}
				</Button>
			</div>
			{error && (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
