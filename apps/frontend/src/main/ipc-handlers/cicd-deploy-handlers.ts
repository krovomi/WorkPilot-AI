/**
 * The CI/CD page's linked services, figures and verdict reviews (#366, lot 4).
 *
 *   cicdTriggers:getLinks       — the projects rolled back with this one, and the others
 *   cicdTriggers:setLinks       — choose them (ids of the app's projects only)
 *   cicdTriggers:getFigures     — the watch figures, computed on this machine
 *   cicdTriggers:reviewVerdict  — a person calls a bad verdict a false alarm, or real
 *
 * The renderer names a registered project folder, project ids and a run id;
 * each is checked here. The links live in the app's user data folder, never
 * in a repository (`main/cicd/deploy-links.ts`).
 */

import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { Project } from "../../shared/types";
import type { DeployLinksView } from "../../shared/types/deploy-watch";
import { computeFigures, isVerdictReview, listDeployWatches, readReviews, writeReview } from "../cicd/deploy-figures";
import { readDeployLinks, rollbackOrder, withLinks, writeDeployLinks } from "../cicd/deploy-links";
import { RUN_ID, readDeployWatch } from "../cicd/deploy-watch";
import { type LinkedRunner, rollBackLinked } from "../cicd/linked-rollback";
import { projectStore } from "../project-store";

const UNKNOWN_PROJECT = { success: false, error: "Project not found" } as const;

function linksDir(): string {
	return app.getPath("userData");
}

function linksView(project: Project): DeployLinksView {
	const others = projectStore.getProjects().filter((p) => p.id !== project.id);
	const chosen = new Set(readDeployLinks(linksDir())[project.id] ?? []);
	const ref = (p: Project) => ({ id: p.id, name: p.name.slice(0, 100) });
	return {
		linked: others.filter((p) => chosen.has(p.id)).map(ref),
		candidates: others.filter((p) => !chosen.has(p.id)).map(ref),
	};
}

/**
 * After a run of `project` rolled back, the projects linked to it go back
 * too (`linked-rollback.ts`). Nothing happens when the rollback did not
 * start, when the plan does not say where it went back to, or when nothing
 * is linked. Never throws.
 */
export async function rollBackLinkedOf(project: Project, runId: string, run: LinkedRunner): Promise<void> {
	const watch = readDeployWatch(project.path, runId, true);
	const since = watch?.plan?.targetAt;
	// A flag turned off redeploys nothing: the linked services stay as they are.
	if (watch?.rollback !== "started" || watch.strategy === "flag" || !since) return;
	const order = rollbackOrder(readDeployLinks(linksDir()), project.id);
	await rollBackLinked({
		root: project,
		runId,
		since,
		order,
		findProject: (id) => projectStore.getProjects().find((p) => p.id === id),
		run,
	});
}

export function registerCicdDeployHandlers(findKnownProject: (dir: unknown) => Project | null): void {
	ipcMain.handle(IPC_CHANNELS.CICD_TRIGGERS_GET_LINKS, (_event, projectDir: unknown) => {
		const project = findKnownProject(projectDir);
		if (!project) return UNKNOWN_PROJECT;
		return { success: true, data: linksView(project) };
	});

	ipcMain.handle(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, (_event, projectDir: unknown, ids: unknown) => {
		const project = findKnownProject(projectDir);
		if (!project) return UNKNOWN_PROJECT;
		const known = new Set(projectStore.getProjects().map((p) => p.id));
		const next = withLinks(readDeployLinks(linksDir()), project.id, ids, known);
		if (!next) return { success: false, error: "invalid-links" };
		try {
			writeDeployLinks(linksDir(), next);
		} catch (err) {
			return { success: false, error: String(err) };
		}
		return { success: true, data: linksView(project) };
	});

	ipcMain.handle(IPC_CHANNELS.CICD_TRIGGERS_GET_FIGURES, (_event, projectDir: unknown) => {
		const project = findKnownProject(projectDir);
		if (!project) return UNKNOWN_PROJECT;
		return {
			success: true,
			data: computeFigures(listDeployWatches(project.path), readReviews(project.path)),
		};
	});

	ipcMain.handle(
		IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT,
		(_event, projectDir: unknown, runId: unknown, review: unknown) => {
			const project = findKnownProject(projectDir);
			if (!project) return UNKNOWN_PROJECT;
			if (typeof runId !== "string" || !RUN_ID.test(runId)) {
				return { success: false, error: "Invalid run id" };
			}
			if (review !== null && !isVerdictReview(review)) {
				return { success: false, error: "invalid-review" };
			}
			const watch = readDeployWatch(project.path, runId, false);
			if (watch?.verdict !== "warning" && watch?.verdict !== "critical") {
				return { success: false, error: "no-bad-verdict" };
			}
			try {
				writeReview(project.path, runId, review);
			} catch (err) {
				return { success: false, error: String(err) };
			}
			return { success: true };
		},
	);
}
