/**
 * Mounted once under the signed-in stack: once in each organization, and
 * again when page activity is turned on, the person is shown what the server
 * measures about them. Reading it is recorded by the server
 * (`usage.notice.seen`), the proof they were told.
 */

import { useEffect, useState } from "react";
import { useSession } from "../auth/session";
import type { UsageNotice } from "./types";
import { UsageNoticeModal } from "./UsageNoticeModal";

export function UsageNoticeGate() {
	const { api, permissions } = useSession();
	const orgId = permissions?.org_id ?? null;
	const [notice, setNotice] = useState<UsageNotice | null>(null);

	useEffect(() => {
		if (!api || !orgId) return;
		let live = true;
		api.usageNotice().then(
			(answer) => {
				if (live && answer.due) setNotice(answer);
			},
			// A server that cannot answer asks again at the next start.
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [api, orgId]);

	const seen = () => {
		setNotice(null);
		void api?.markUsageNoticeSeen().catch(() => undefined);
	};

	return <UsageNoticeModal notice={notice} onClose={seen} />;
}
