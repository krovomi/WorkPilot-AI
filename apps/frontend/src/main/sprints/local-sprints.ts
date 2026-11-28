/**
 * A local project's sprints, in `<project>/.workpilot/sprints.json` (next
 * to its specs, ignored by git like them). Written whole, through a
 * temporary file renamed over the old one, one operation at a time per
 * project, so two quick clicks never lose a sprint.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Project } from "../../shared/types";
import type { Sprint } from "../../shared/types/sprint";
import { readSprints } from "../../shared/utils/sprints";

const FILE = "sprints.json";
const queues = new Map<string, Promise<unknown>>();

export function sprintsFile(project: Pick<Project, "path" | "autoBuildPath">): string {
	return path.join(project.path, project.autoBuildPath || ".workpilot", FILE);
}

export async function readLocalSprints(project: Pick<Project, "path" | "autoBuildPath">): Promise<Sprint[]> {
	try {
		return readSprints(JSON.parse(await fs.readFile(sprintsFile(project), "utf-8")));
	} catch {
		// No file yet, or one that is not ours: no sprint.
		return [];
	}
}

async function writeLocalSprints(project: Pick<Project, "path" | "autoBuildPath">, sprints: Sprint[]): Promise<void> {
	const file = sprintsFile(project);
	await fs.mkdir(path.dirname(file), { recursive: true });
	// The folder resolved (links included) stays inside the project.
	const [root, folder] = await Promise.all([fs.realpath(project.path), fs.realpath(path.dirname(file))]);
	const relative = path.relative(root, folder);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("The sprints file is not the project's");
	const temporary = `${file}.${process.pid}.tmp`;
	// A file left there, or a link a cloned repository planted, is removed, never followed.
	await fs.rm(temporary, { force: true });
	await fs.writeFile(temporary, `${JSON.stringify({ version: 1, sprints }, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	await fs.rename(temporary, file);
}

/**
 * Reads the sprints, applies `change`, writes them back when it gave a new
 * list; serialized per project.
 */
export function updateLocalSprints<T extends { sprints?: Sprint[] }>(
	project: Pick<Project, "id" | "path" | "autoBuildPath">,
	change: (sprints: Sprint[]) => T,
): Promise<T> {
	const previous = queues.get(project.id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(async () => {
			const result = change(await readLocalSprints(project));
			if (result.sprints) await writeLocalSprints(project, result.sprints);
			return result;
		});
	queues.set(project.id, next);
	return next;
}
