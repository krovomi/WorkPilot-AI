/**
 * What stands between a server-mode person and the app: the sign-in screen
 * until a session is open, then, once in each organization, the notice of
 * what the server measures about them.
 */
import { useEffect, useState } from "react";
import type { UsageNotice } from "@shared/types/server-usage";
import { usePermissionsStore } from "@/stores/permissions-store";
import { useServerSessionStore } from "@/stores/server-session-store";
import { ServerLoginScreen } from "./ServerLoginScreen";
import { UsageNoticeDialog } from "./UsageNotice";

function NoticeWhenDue() {
	const signedIn = useServerSessionStore((s) => s.mode === "server" && s.isAuthenticated);
	const orgId = usePermissionsStore((s) => s.orgId);
	const [notice, setNotice] = useState<UsageNotice | null>(null);

	useEffect(() => {
		const api = globalThis.electronAPI?.serverUsage;
		if (!signedIn || !orgId || !api) return;
		let live = true;
		void api.getUsageNotice().then((result) => {
			if (live && result.ok && result.data.due) setNotice(result.data);
		});
		return () => {
			live = false;
		};
	}, [signedIn, orgId]);

	function seen() {
		setNotice(null);
		void globalThis.electronAPI?.serverUsage?.markUsageNoticeSeen();
	}

	return <UsageNoticeDialog notice={notice} onClose={seen} />;
}

export function ServerGate({ showLogin }: { readonly showLogin: boolean }) {
	return showLogin ? <ServerLoginScreen /> : <NoticeWhenDue />;
}
