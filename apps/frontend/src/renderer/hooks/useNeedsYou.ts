import { useEffect, useRef } from "react";
import type { SidebarView } from "../components/Sidebar";
import { useProjectStore } from "../stores/project-store";
import { startTask, submitReview, useTaskStore } from "../stores/task-store";

interface UseNeedsYouOptions {
	onNavigate: (view: SidebarView) => void;
}

/**
 * The renderer's half of "needs you" (`main/notification-service.ts`).
 *
 * - A desktop notification was clicked: open its project and spotlight the
 *   task on the Kanban.
 * - A plan was approved from Telegram: run the same two steps as the Approve
 *   button (submit the review, start the task) and tell main how it went.
 *   Main has already checked that the plan is waiting; a task the board shows
 *   in another state is not approved.
 */
export function useNeedsYou({ onNavigate }: UseNeedsYouOptions): void {
	const onNavigateRef = useRef(onNavigate);
	onNavigateRef.current = onNavigate;

	useEffect(() => {
		const api = globalThis.electronAPI;
		if (typeof api?.onNeedsYouOpenTask !== "function") return;

		const offOpen = api.onNeedsYouOpenTask((taskId, projectId) => {
			const projects = useProjectStore.getState();
			if (projects.selectedProjectId !== projectId) {
				projects.openProjectTab(projectId);
				projects.selectProject(projectId);
			}
			onNavigateRef.current("kanban");
			useTaskStore.getState().jumpToTask(taskId);
		});

		const offApprove = api.onNeedsYouApprovePlan((requestId, taskId) => {
			void approvePlan(taskId).then((outcome) =>
				api.reportNeedsYouApproval(requestId, outcome),
			);
		});

		return () => {
			offOpen();
			offApprove();
		};
	}, []);
}

export async function approvePlan(taskId: string): Promise<"approved" | "notPending"> {
	const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
	if (task && !(task.status === "human_review" && task.reviewReason === "plan_review")) {
		return "notPending";
	}
	try {
		if (!(await submitReview(taskId, true))) return "notPending";
		startTask(taskId);
		return "approved";
	} catch {
		return "notPending";
	}
}
