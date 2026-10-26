import { ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskPermissionRequest } from "../../../shared/types/task-permission";
import { cn } from "../../lib/utils";
import {
	answerTaskPermission,
	pendingPermission,
	useTaskPermissionStore,
} from "../../stores/task-permission-store";
import { Button } from "../ui/button";

/** Allow first, then refuse: the order Gemini offers them in, kept stable. */
const KIND_ORDER = ["allow_once", "allow_always", "reject_once", "reject_always"];

interface TaskPermissionPromptProps {
	readonly taskId: string;
	readonly specId?: string;
}

/**
 * The question an ACP agent is waiting on, on its card. The title and the
 * options' names are the agent's words, shown as text. The answer is checked
 * again in main and in the build.
 */
export function TaskPermissionPrompt({ taskId, specId }: TaskPermissionPromptProps) {
	const request = useTaskPermissionStore((state) =>
		pendingPermission(state.byTask, taskId, specId),
	);
	if (!request) return null;
	return <PermissionQuestion key={request.requestId} request={request} />;
}

function PermissionQuestion({ request }: { readonly request: TaskPermissionRequest }) {
	const { t } = useTranslation(["tasks"]);
	const [sending, setSending] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const options = [...request.options].sort(
		(a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
	);

	const choose = async (optionId: string) => {
		setSending(optionId);
		setFailure(null);
		try {
			const result = await answerTaskPermission(request, optionId);
			if (!result.ok) setFailure(t(`tasks:permission.failure.${result.reason}`));
		} catch {
			setFailure(t("tasks:permission.failure.process_gone"));
		} finally {
			setSending(null);
		}
	};

	return (
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: stops the card's click, not an interaction of its own
		<fieldset
			aria-label={t("tasks:permission.label", { agent: request.agent })}
			className="mt-3 min-w-0 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs space-y-2"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<div className="flex items-start gap-1.5">
				<ShieldQuestion className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
				<div className="min-w-0 space-y-0.5">
					<p className="font-medium">{t("tasks:permission.asks", { agent: request.agent })}</p>
					<p className="break-words">{request.title}</p>
					{request.locations.slice(0, 3).map((location) => (
						<p key={location} className="font-mono text-[11px] text-muted-foreground break-all">
							{location}
						</p>
					))}
				</div>
			</div>
			<div className="flex flex-wrap gap-1">
				{options.map((option) => (
					<Button
						key={option.optionId}
						size="sm"
						variant={option.kind.startsWith("allow") ? "default" : "outline"}
						className={cn("h-6 px-2 text-[11px]")}
						disabled={sending !== null}
						onClick={() => void choose(option.optionId)}
					>
						{option.name}
					</Button>
				))}
			</div>
			<p className="text-[11px] text-muted-foreground">
				{t("tasks:permission.expires", {
					time: new Date(request.expiresAt).toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					}),
				})}
			</p>
			{failure && <p className="text-[11px] text-destructive">{failure}</p>}
		</fieldset>
	);
}
