/**
 * Whether a project's builds may send their full suite to the forge's CI.
 *
 * The « Build rouge » loop knows which projects have a CI it can follow (it
 * resolves their provider on every poll) and says so here; the build's
 * environment is assembled synchronously from this answer (`build-env.ts`).
 * A suite whose pipeline never started leaves the route aside for a day, so
 * the next suites of that project run on the machine instead of waiting on a
 * CI that does not run task branches.
 */

const SUSPEND_MS = 24 * 60 * 60_000;

const followed = new Set<string>();
const suspendedUntil = new Map<string, number>();

export function setCiFollowed(projectId: string, followable: boolean): void {
	if (followable) followed.add(projectId);
	else followed.delete(projectId);
}

export function suspendCiRoute(projectId: string, now: number = Date.now()): void {
	suspendedUntil.set(projectId, now + SUSPEND_MS);
}

export function ciRouteAvailable(projectId: string, now: number = Date.now()): boolean {
	if (!followed.has(projectId)) return false;
	const until = suspendedUntil.get(projectId);
	if (until === undefined) return true;
	if (now < until) return false;
	suspendedUntil.delete(projectId);
	return true;
}

/** Tests only. */
export function resetCiRoutes(): void {
	followed.clear();
	suspendedUntil.clear();
}
