import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SidebarView } from "../components/Sidebar";
import { ToastAction } from "../components/ui/toast";
import type { Activity } from "../stores/activity-store";
import { useActivityStore } from "../stores/activity-store";
import { toast } from "./use-toast";

/**
 * How long finishes are collected before one toast is raised for them.
 *
 * `use-toast` keeps a single slot (`TOAST_LIMIT = 1`), so three pages finishing
 * together used to mean two announcements nobody ever saw. Raising the limit
 * would stack three cards over the app instead; collecting them into one line
 * is the answer that stays true as the number of pages grows.
 */
const COALESCE_MS = 1200;

interface UseActivityNotificationsOptions {
	onNavigate: (view: SidebarView) => void;
}

/**
 * Announces work that ended on a page the user was not looking at.
 *
 * Kanban builds are deliberately excluded: `useTaskNotifications` already
 * announces those, with the task's title and the distinction between a
 * finished build and one that landed in review because it failed. Two toasts
 * for one event is worse than none.
 */
export function useActivityNotifications({
	onNavigate,
}: UseActivityNotificationsOptions): void {
	const { t } = useTranslation(["common", "navigation"]);

	const tRef = useRef(t);
	const navigateRef = useRef(onNavigate);
	tRef.current = t;
	navigateRef.current = onNavigate;

	useEffect(() => {
		const announced = new Set<string>();
		let pending: Activity[] = [];
		let timer: ReturnType<typeof setTimeout> | null = null;

		const flush = () => {
			timer = null;
			const batch = pending;
			pending = [];
			if (batch.length === 0) return;

			const translate = tRef.current;
			// A failure decides the wording and the variant even in a mixed
			// batch: it is the half of the news that needs an action.
			const failures = batch.filter((a) => a.status === "error");
			const worst = failures[0] ?? batch[0];
			const isFailure = failures.length > 0;

			const title =
				batch.length === 1
					? translate(
							isFailure
								? "activityCentre.toast.failedOne"
								: "activityCentre.toast.finishedOne",
							{ name: translate(worst.labelKey) },
						)
					: translate(
							isFailure
								? "activityCentre.toast.failedMany"
								: "activityCentre.toast.finishedMany",
							{ count: batch.length },
						);

			const view = worst.view;
			const open = () => navigateRef.current(view);
			const viewLabel = translate("activityCentre.toast.open");

			toast({
				title,
				description: batch.length === 1 ? worst.detail : undefined,
				variant: isFailure ? "destructive" : "default",
				onClick: open,
				action: (
					<ToastAction
						altText={viewLabel}
						onClick={(event) => {
							event.stopPropagation();
							open();
						}}
					>
						{viewLabel}
					</ToastAction>
				),
			});
		};

		const inspect = (activities: Activity[]) => {
			for (const activity of activities) {
				if (activity.status === "running") {
					// A job that runs again is news again when it ends.
					announced.delete(activity.id);
					continue;
				}
				// `seen` is already true for work that ended on the page in front
				// of the user, which is exactly the work not worth a toast.
				if (activity.seen || announced.has(activity.id)) continue;
				if (activity.view === "kanban") continue;

				announced.add(activity.id);
				pending.push(activity);
			}

			if (pending.length > 0 && timer === null) {
				timer = setTimeout(flush, COALESCE_MS);
			}
		};

		inspect(useActivityStore.getState().activities);

		const unsubscribe = useActivityStore.subscribe((state, previous) => {
			if (state.activities !== previous.activities) inspect(state.activities);
		});

		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, []);
}
