/**
 * Mounted once under the signed-in stack: when the team server stopped while
 * some of the person's runs were queued or running, it asks which to resume,
 * as the desktop app asks at launch. Each answer goes to the server, so the
 * desktop does not ask again about the same runs.
 */

import { useEffect, useState } from "react";
import { useSession } from "../auth/session";
import { InterruptedRunsModal } from "./InterruptedRunsModal";
import type { InterruptedRun } from "./types";

export function InterruptedRunsGate() {
	const { api, permissions } = useSession();
	const orgId = permissions?.org_id ?? null;
	const [runs, setRuns] = useState<InterruptedRun[] | null>(null);

	useEffect(() => {
		if (!api || !orgId) return;
		let live = true;
		api.interruptedRuns().then(
			(answer) => {
				if (live && answer.length > 0) setRuns(answer);
			},
			// A server that cannot answer asks again at the next start.
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [api, orgId]);

	if (!api || !runs) return null;
	return <InterruptedRunsModal key={orgId} api={api} runs={runs} onClose={() => setRuns(null)} />;
}
