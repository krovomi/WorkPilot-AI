import { ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { unisolatedStatuses, useTaskSandboxStore } from "../../stores/task-sandbox-store";

interface TaskSandboxNoticeProps {
	readonly taskId: string;
	readonly specId?: string;
}

/**
 * Said on the card when a build's commands are not isolated: the OS sandbox
 * is unavailable on this machine, missing for this provider, or turned off.
 * Nothing is shown while they are isolated. The reason is the backend's
 * (stable English), shown as text.
 */
export function TaskSandboxNotice({ taskId, specId }: TaskSandboxNoticeProps) {
	const { t } = useTranslation(["tasks"]);
	// The map, not a filtered copy: a selector returning a new array on every
	// read would re-render the card forever.
	const byTask = useTaskSandboxStore((state) => state.byTask);
	const statuses = unisolatedStatuses(byTask, taskId, specId);
	if (statuses.length === 0) return null;
	const details = statuses
		.map((status) =>
			status.state === "off"
				? t("tasks:sandbox.off", { provider: status.provider })
				: t("tasks:sandbox.unavailable", {
						provider: status.provider,
						reason: status.reason ?? t("tasks:sandbox.noReason"),
					}),
		)
		.join("\n");
	return (
		<div
			className="mt-2 flex items-center gap-1 text-[11px] text-warning"
			title={details}
			data-testid="task-sandbox-notice"
		>
			<ShieldOff className="h-3 w-3 shrink-0" />
			<span>{t("tasks:sandbox.notIsolated")}</span>
		</div>
	);
}
