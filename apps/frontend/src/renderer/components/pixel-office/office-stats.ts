import type { Task } from "../../../shared/types/task";

/** Tasks shipped (done, or turned into a pull request) on `now`'s calendar day. */
export function shippedToday(tasks: readonly Task[], now: Date): number {
	return tasks.filter((t) => {
		if (t.status !== "done" && t.status !== "pr_created") return false;
		const at = new Date(t.updatedAt);
		return (
			at.getFullYear() === now.getFullYear() &&
			at.getMonth() === now.getMonth() &&
			at.getDate() === now.getDate()
		);
	}).length;
}
