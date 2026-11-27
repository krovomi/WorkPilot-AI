import type { SidebarView } from "@/components/Sidebar";
import { recordViewVisit } from "@/stores/view-usage-store";

/**
 * A view of the left menu opened (or none, `null`): counted for this
 * machine's view usage (Settings → Debug), and passed to the main, which
 * counts it for the server's page activity only in server mode and only
 * while the organization turned page activity on (`main/server-usage.ts`).
 */
export function noteViewOpened(view: SidebarView | null): void {
	recordViewVisit(view);
	if (view) globalThis.electronAPI?.serverUsage?.notePageVisit(view);
}
