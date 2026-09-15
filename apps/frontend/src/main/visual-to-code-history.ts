/**
 * Where an architecture's construction history is kept.
 *
 * One file per architecture, under `userData/visual-to-code/history/`. Per
 * architecture rather than one index, for two reasons that both bite at the
 * same moment: a snapshot rewrites only the document it belongs to, and
 * deleting an architecture deletes one file instead of rewriting everyone
 * else's.
 *
 * On disk rather than in the renderer's `localStorage` because the numbers do
 * not fit: sixty snapshots of a forty-block architecture, times however many
 * architectures are open, is megabytes against a ~5 MB quota the whole app
 * shares — and a quota that overflows throws on write, silently losing the
 * work this feature exists to protect.
 *
 * The file holds the bodies; `listVersions` returns only metadata. Reading a
 * megabyte here is a Node file read, but *sending* it to the renderer so it
 * can draw sixty rows would put sixty diagrams in the window's heap to display
 * sixty dates.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import {
	ARCHITECTURE_HISTORY_LIMIT,
	type ArchitectureVersion,
	type ArchitectureVersionInput,
	type ArchitectureVersionMeta,
} from "../shared/types/visual-to-code-history";
import { logger } from "./app-logger";

interface HistoryFile {
	architectureId: string;
	versions: ArchitectureVersion[];
}

/** Rejects anything that is not one of our own generated ids. */
function isSafeId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function historyDir(): string {
	const dir = path.join(app.getPath("userData"), "visual-to-code", "history");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * The file an architecture's history lives in.
 *
 * The id is validated rather than escaped: it is generated here and by the
 * renderer, never typed, so anything failing the pattern is a bug or an
 * attempt at one — and `path.join` with `../..` would otherwise write wherever
 * the caller liked.
 */
function historyPath(architectureId: string): string {
	if (!isSafeId(architectureId)) {
		throw new Error(`Invalid architecture id: ${architectureId}`);
	}
	return path.join(historyDir(), `${architectureId}.json`);
}

function readFile(architectureId: string): HistoryFile {
	const file = historyPath(architectureId);
	if (!existsSync(file)) return { architectureId, versions: [] };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as HistoryFile;
		return {
			architectureId,
			versions: Array.isArray(parsed?.versions) ? parsed.versions : [],
		};
	} catch (error) {
		// A truncated or hand-edited file must not take the canvas down with
		// it. An empty history is a loss worth reporting; a crash on opening
		// the page is worse, and the live document is not in this file.
		logger.warn(`[visualToCodeHistory] Unreadable history for ${architectureId}:`, error);
		return { architectureId, versions: [] };
	}
}

/**
 * Write through a temporary file and rename.
 *
 * A snapshot is taken while the user keeps editing, so a crash mid-write is
 * not hypothetical — and a half-written JSON file is a history that reads as
 * empty on the next open. `rename` within a directory is atomic on every
 * platform this ships to.
 */
function writeFileAtomic(architectureId: string, data: HistoryFile): void {
	const file = historyPath(architectureId);
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, JSON.stringify(data), "utf-8");
	renameSync(temporary, file);
}

function toMeta(version: ArchitectureVersion): ArchitectureVersionMeta {
	const { nodes: _nodes, edges: _edges, diagramType: _type, ...meta } = version;
	return meta;
}

/**
 * Drop the oldest auto-captured versions once there are too many.
 *
 * Pinned versions are not counted and never dropped: the cap exists to stop an
 * afternoon of editing growing without bound, and a version somebody named is
 * not that — it is a decision, and deleting it is the user's to make.
 */
function applyLimit(versions: ArchitectureVersion[]): ArchitectureVersion[] {
	const unpinned = versions.filter((v) => !v.pinned);
	if (unpinned.length <= ARCHITECTURE_HISTORY_LIMIT) return versions;
	const doomed = new Set(
		unpinned.slice(0, unpinned.length - ARCHITECTURE_HISTORY_LIMIT).map((v) => v.id),
	);
	return versions.filter((v) => !doomed.has(v.id));
}

/** Metadata for every version of an architecture, oldest first. */
export function listVersions(architectureId: string): ArchitectureVersionMeta[] {
	return readFile(architectureId).versions.map(toMeta);
}

/** One version, with the diagram it captured. */
export function getVersion(
	architectureId: string,
	versionId: string,
): ArchitectureVersion | null {
	return (
		readFile(architectureId).versions.find((v) => v.id === versionId) ?? null
	);
}

/** Record a step. Returns the metadata list as it stands afterwards. */
export function appendVersion(
	architectureId: string,
	input: ArchitectureVersionInput,
): ArchitectureVersionMeta[] {
	const file = readFile(architectureId);
	const version: ArchitectureVersion = {
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		label: input.label ?? null,
		pinned: input.pinned ?? false,
		summary: input.summary ?? null,
		restoredFrom: input.restoredFrom ?? null,
		nodeCount: Array.isArray(input.nodes) ? input.nodes.length : 0,
		edgeCount: Array.isArray(input.edges) ? input.edges.length : 0,
		diagramType: input.diagramType,
		nodes: input.nodes,
		edges: input.edges,
	};
	file.versions = applyLimit([...file.versions, version]);
	writeFileAtomic(architectureId, file);
	return file.versions.map(toMeta);
}

/**
 * Name a version, or take its name away.
 *
 * Naming is also what pins it, because those are the same act: a step worth
 * naming is a step worth keeping, and asking the user to do both would mean
 * watching named steps fall off the bottom.
 */
export function labelVersion(
	architectureId: string,
	versionId: string,
	label: string | null,
): ArchitectureVersionMeta[] {
	const file = readFile(architectureId);
	const version = file.versions.find((v) => v.id === versionId);
	if (version) {
		const trimmed = label?.trim() || null;
		version.label = trimmed;
		version.pinned = trimmed !== null;
		// Un-naming re-exposes it to the cap, which may be overdue.
		file.versions = applyLimit(file.versions);
		writeFileAtomic(architectureId, file);
	}
	return file.versions.map(toMeta);
}

/** Remove one version. The only way a pinned version ever goes away. */
export function deleteVersion(
	architectureId: string,
	versionId: string,
): ArchitectureVersionMeta[] {
	const file = readFile(architectureId);
	file.versions = file.versions.filter((v) => v.id !== versionId);
	writeFileAtomic(architectureId, file);
	return file.versions.map(toMeta);
}

/** Drop an architecture's whole history, when the architecture itself goes. */
export function deleteHistory(architectureId: string): void {
	const file = historyPath(architectureId);
	try {
		rmSync(file, { force: true });
	} catch (error) {
		logger.warn(`[visualToCodeHistory] Could not delete ${architectureId}:`, error);
	}
}
