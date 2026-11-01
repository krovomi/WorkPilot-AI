/**
 * A job-written feature (roadmap, ideation) on screen: its snapshot, and
 * while its job runs, the job's last output line, read every few seconds;
 * the snapshot is read again when the job ends.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobFeature } from "../api/endpoints";
import { useApi } from "../auth/session";
import { useLoad } from "../hooks/useLoad";
import { type FeatureJob, JOB_ACTIVE } from "./types";

export const JOB_POLL_MS = 3_000;

export function useFeature(feature: JobFeature, projectId: string) {
	const api = useApi();
	const load = useCallback(() => api.featureSnapshot(feature, projectId), [api, feature, projectId]);
	const snapshot = useLoad(load);
	const [job, setJob] = useState<FeatureJob | null>(null);
	const [lastLine, setLastLine] = useState<string | null>(null);
	const after = useRef(0);
	const { reload } = snapshot;

	// The snapshot names the last job: follow it if it still runs.
	useEffect(() => {
		const latest = snapshot.data?.job ?? null;
		setJob((current) => (current && current.id === latest?.id ? current : latest));
	}, [snapshot.data]);

	const active = !!job && JOB_ACTIVE.has(job.status);
	const jobId = job?.id;
	useEffect(() => {
		if (!active || !jobId) return;
		const timer = setInterval(async () => {
			try {
				const out = await api.featureJob(feature, projectId, jobId, after.current);
				after.current = out.next;
				const line = out.lines.filter((l) => l.trim()).at(-1);
				if (line) setLastLine(line.slice(0, 300));
				setJob(out);
				if (!JOB_ACTIVE.has(out.status)) await reload();
			} catch {
				// The next tick tries again; the screen keeps what it has.
			}
		}, JOB_POLL_MS);
		return () => clearInterval(timer);
	}, [active, jobId, api, feature, projectId, reload]);

	const start = useCallback(
		async (options: Record<string, unknown> = {}) => {
			const started = await api.startFeatureJob(feature, projectId, options);
			after.current = 0;
			setLastLine(null);
			setJob(started);
		},
		[api, feature, projectId],
	);

	const cancel = useCallback(async () => {
		if (jobId) await api.cancelFeatureJob(feature, projectId, jobId);
	}, [api, feature, projectId, jobId]);

	return { ...snapshot, job, active, lastLine, start, cancel };
}
