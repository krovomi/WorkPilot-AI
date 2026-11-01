import { useEffect, useRef, useState } from "react";
import type {
	SharedAnalysisKind,
	SharedAnalysisReport,
} from "../../preload/api/modules/shared-analysis-api";

/**
 * The last report of an analysis that a member of a server project saved on
 * the server, handed to the view's store with `apply` unless a scan runs;
 * null for a local project, which keeps none (`main/ipc-handlers/server-analyses.ts`).
 */
export function useSharedAnalysisReport<R>(
	kind: SharedAnalysisKind,
	projectPath: string | undefined,
	apply: (report: R) => void,
	scanning: boolean,
): SharedAnalysisReport | null {
	const [saved, setSaved] = useState<SharedAnalysisReport | null>(null);
	// Read once per project, not on each store change.
	const latest = useRef({ apply, scanning });
	latest.current = { apply, scanning };
	useEffect(() => {
		setSaved(null);
		const api = globalThis.electronAPI;
		if (!projectPath || !api?.getSharedAnalysisReport) return;
		let current = true;
		api.getSharedAnalysisReport(kind, projectPath).then(
			(found) => {
				if (!current || !found || found.report == null) return;
				setSaved(found);
				if (!latest.current.scanning) latest.current.apply(found.report as R);
			},
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [kind, projectPath]);
	return saved;
}
