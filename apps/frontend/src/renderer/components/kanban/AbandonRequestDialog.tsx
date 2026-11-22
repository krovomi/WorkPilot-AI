/**
 * The reason dialog of tasks set aside from the board: a drop on
 * « Abandonnée » or the menu of a task. Mounted once by the board; opened by
 * stores/abandon-request-store.ts.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AbandonChoice } from "../../../shared/utils/task-lifecycle";
import { toast } from "../../hooks/use-toast";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { abandonTask, useTaskStore } from "../../stores/task-store";
import { AbandonDialog } from "../task-detail/AbandonDialog";

export function AbandonRequestDialog() {
	const { t } = useTranslation(["tasks"]);
	const ids = useAbandonRequestStore((s) => s.ids);
	const close = useAbandonRequestStore((s) => s.close);
	const allTasks = useTaskStore((s) => s.tasks);
	const tasks = useMemo(() => {
		const wanted = new Set(ids);
		return allTasks.filter((task) => wanted.has(task.id));
	}, [allTasks, ids]);
	const [busy, setBusy] = useState(false);

	const onAbandon = async (choice: AbandonChoice) => {
		setBusy(true);
		try {
			const results = await Promise.all(tasks.map((task) => abandonTask(task.id, choice)));
			const failed = results.filter((r) => !r.success);
			if (failed.length > 0) {
				toast({
					title: t("tasks:abandon.failedTitle"),
					description: failed[0].error || t("tasks:abandon.failedDescription"),
					variant: "destructive",
				});
			} else {
				toast({
					title: t("tasks:abandon.abandonedTitleMany", { count: tasks.length }),
					description: t("tasks:abandon.abandonedDescription"),
					duration: 4000,
				});
			}
			close();
		} finally {
			setBusy(false);
		}
	};

	return (
		<AbandonDialog
			open={tasks.length > 0}
			tasks={tasks}
			isAbandoning={busy}
			onOpenChange={(open) => {
				if (!open && !busy) close();
			}}
			onAbandon={(choice) => void onAbandon(choice)}
		/>
	);
}
