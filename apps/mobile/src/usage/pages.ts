/**
 * The phone's screens whose opens are counted for the server's page activity
 * (only while the person's organization turned it on), named from their
 * route: groups such as `(app)` are left out, a project, card or session id
 * never enters the name, and a screen that shows one item of a list ends in
 * `detail` (`projects/[projectId]/cards/[cardId]` is `projects/cards/detail`).
 * The server keeps the same closed list
 * (`apps/backend/server/services/page_activity.py`) and refuses any other.
 */
export const MOBILE_PAGES = [
	"home",
	"inbox",
	"needs-you",
	"admin",
	"admin/groups",
	"admin/groups/detail",
	"admin/invitations",
	"admin/members",
	"admin/roles",
	"admin/roles/detail",
	"projects",
	"projects/analyses",
	"projects/analyses/detail",
	"projects/cards/detail",
	"projects/cards/files",
	"projects/cards/logs",
	"projects/chat",
	"projects/context",
	"projects/dashboard",
	"projects/delegations",
	"projects/forge",
	"projects/forge/issues/detail",
	"projects/forge/pulls/detail",
	"projects/governance",
	"projects/ideas",
	"projects/insights",
	"projects/insights/detail",
	"projects/leaderboard",
	"projects/more",
	"projects/new",
	"projects/roadmap",
	"projects/sessions",
	"projects/waves",
	"replays",
	"settings",
	"share",
	"tokens",
] as const;

export type MobilePage = (typeof MOBILE_PAGES)[number];

const KNOWN: ReadonlySet<string> = new Set(MOBILE_PAGES);

/**
 * The counted name of the screen at these route segments (`useSegments()`),
 * or null for a screen outside the list (sign-in, a route this list does
 * not know yet).
 */
export function pageOf(segments: readonly string[]): MobilePage | null {
	const parts: string[] = [];
	segments.forEach((segment, index) => {
		if (segment.startsWith("(")) return;
		if (segment.startsWith("[")) {
			// The item of a list, except the project itself (its board).
			const last = index === segments.length - 1;
			if (last && parts.length > 0 && parts[parts.length - 1] !== "projects") {
				parts.push("detail");
			}
			return;
		}
		if (segment !== "index") parts.push(segment);
	});
	const name = parts.join("/") || "home";
	return KNOWN.has(name) ? (name as MobilePage) : null;
}
