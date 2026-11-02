import { ArrowRight, BellRing } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { usePrFollowupStore } from "../../stores/pr-followup-store";
import { useTaskPanelStore } from "../../stores/task-panel-store";
import { pendingPermission, useTaskPermissionStore } from "../../stores/task-permission-store";
import { useTaskStore } from "../../stores/task-store";
import { failureBannerDomId } from "./panel-sections";
import { TaskFailureBanner } from "./TaskFailureBanner";
import { collectWaitingItems, type WaitingItem } from "./waiting-items";

interface TaskWaitingBannerProps {
	readonly task: Task;
	/** Brings the Overview on screen; the card is then shown by its slot. */
	readonly onShowOverview: () => void;
}

/** The items for a task, from the stores that already hold them. */
export function useWaitingItems(task: Task): WaitingItem[] {
	const hasPermissionQuestion = useTaskPermissionStore((s) =>
		Boolean(pendingPermission(s.byTask, task.id, task.specId)),
	);
	const pipeline = useTaskStore((s) => s.pipelineStatuses[task.id]);
	const prFollowup = usePrFollowupStore((s) => s.byTask[task.id]);
	return collectWaitingItems({ task, hasPermissionQuestion, pipeline, prFollowup });
}

/**
 * « Ce qui vous attend » : en haut du panneau de tâche, ce qui demande la
 * personne maintenant — un plan à approuver, une CI rouge, la question d'un
 * agent, un objectif non atteint, un build en échec, une revue. Chaque ligne
 * mène à la carte qui le traite (l'onglet s'ouvre, la carte défile à l'écran
 * et prend le focus). Rien à faire, pas de bannière.
 *
 * La bannière d'échec (`TaskFailureBanner`, la phrase qui dit pourquoi) reste
 * juste en dessous, au-dessus des onglets : c'est la cible de la ligne
 * « le build a échoué ».
 */
export function TaskWaitingBanner({ task, onShowOverview }: TaskWaitingBannerProps) {
	const { t } = useTranslation(["tasks"]);
	const items = useWaitingItems(task);
	const reveal = useTaskPanelStore((s) => s.reveal);

	const go = (item: WaitingItem) => {
		if (item.target === "failure") {
			const el = document.getElementById(failureBannerDomId(task.id));
			el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
			el?.focus({ preventScroll: true });
			return;
		}
		reveal(task.id, item.target);
		onShowOverview();
	};

	return (
		<>
			{items.length > 0 && (
				<section
					aria-labelledby={`task-${task.id}-waiting-title`}
					className="mx-4 mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3"
				>
					<h2
						id={`task-${task.id}-waiting-title`}
						className="flex items-center gap-2 text-sm font-medium text-foreground"
					>
						<BellRing className="h-4 w-4 shrink-0 text-warning" aria-hidden />
						{t("tasks:waiting.title")}
					</h2>
					<ul className="mt-2 flex flex-col gap-1">
						{items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									onClick={() => go(item)}
									className="group inline-flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span>{t(`tasks:waiting.items.${item.id}`)}</span>
									<ArrowRight
										className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
										aria-hidden
									/>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
			<div id={failureBannerDomId(task.id)} tabIndex={-1} className="outline-none">
				<TaskFailureBanner task={task} />
			</div>
		</>
	);
}
