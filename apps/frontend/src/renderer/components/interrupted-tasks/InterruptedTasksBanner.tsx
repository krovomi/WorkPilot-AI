import { PowerOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { countInterrupted } from "../../lib/interrupted-task";
import { useInterruptedTasksStore } from "../../stores/interrupted-tasks-store";

/**
 * The Kanban header's reminder of builds the app interrupted, left for later
 * or never offered (« Ne rien reprendre »): reopens the launch dialog on this
 * project's interrupted builds.
 */
export function InterruptedTasksBanner({
	projectId,
	tasks,
}: {
	readonly projectId: string | undefined;
	readonly tasks: readonly Task[];
}) {
	const { t } = useTranslation(["tasks"]);
	const count = useMemo(() => countInterrupted(tasks), [tasks]);
	const dialogOpen = useInterruptedTasksStore((s) => s.offer !== null);
	const [busy, setBusy] = useState(false);
	if (!projectId || count === 0 || dialogOpen) return null;

	const open = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const listed = await globalThis.electronAPI.listInterruptedTasks(projectId);
			if (listed.length === 0) {
				toast({ title: t("tasks:interrupted.banner.none") });
				return;
			}
			useInterruptedTasksStore.getState().receive({ mode: "ask", tasks: listed });
		} finally {
			setBusy(false);
		}
	};

	return (
		<button
			type="button"
			data-testid="interrupted-tasks-banner"
			disabled={busy}
			onClick={() => void open()}
			className="flex items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2.5 py-1 text-xs font-medium tabular-nums text-info transition-colors hover:bg-info/15"
		>
			<PowerOff className="h-3.5 w-3.5" />
			{t("tasks:interrupted.banner.chip", { count })}
		</button>
	);
}
