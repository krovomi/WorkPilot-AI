/**
 * IPC of « Proposer le sprint » (docs/architecture/sprint-proposal.md). The
 * renderer names a project, a sprint, a variant from a closed list and, for
 * this proposal only, a goal and a capacity; all are checked here (S6). The
 * cards and the sprints are read here too, from the project's file or from
 * the server, which only sends what its caller may read. Nothing is written:
 * the person adds the cards through the sprint store.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	IPCResult,
	Sprint,
	SprintProposal,
	SprintProposalRequest,
	SprintProposalVariant,
	Task,
} from "../../shared/types";
import { SPRINT_PROPOSAL_LIMITS, SPRINT_PROPOSAL_VARIANTS } from "../../shared/types/sprint-proposal";
import { isSprintId, MAX_CAPACITY, sprintCapacity, sprintProgress } from "../../shared/utils/sprints";
import { getAppLanguage } from "../app-language";
import type { CompletionFn } from "../board-ask/board-ask-service";
import { runOneShotLLM } from "../oneshot-llm";
import { projectStore } from "../project-store";
import { getRemoteTasks } from "../remote-board";
import { getServerProject } from "../server-projects";
import { proposeSprint } from "../sprint-proposal/proposal-service";
import { readLocalSprints } from "../sprints/local-sprints";
import { listServerSprints } from "../sprints/server-sprints";

const COMPLETION_TIMEOUT_MS = 60_000;
const MAX_PROJECT_ID = 200;

/** A request once checked: its variant is always named. */
export type ProposalAsk = SprintProposalRequest & { variant: SprintProposalVariant };

/** The request, revalidated (S6), or the reason it is refused. */
export function parseSprintProposalRequest(raw: unknown): ProposalAsk | string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "Invalid request";
	const { projectId, sprintId, variant, goal, capacity } = raw as Record<string, unknown>;
	if (typeof projectId !== "string" || !projectId || projectId.length > MAX_PROJECT_ID) return "Invalid project id";
	if (!isSprintId(sprintId)) return "Invalid sprint id";
	if (variant !== undefined && !SPRINT_PROPOSAL_VARIANTS.includes(variant as never)) return "Invalid variant";
	if (goal !== undefined && (typeof goal !== "string" || goal.length > SPRINT_PROPOSAL_LIMITS.goal)) {
		return "Invalid goal";
	}
	if (
		capacity !== undefined &&
		(typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
	) {
		return "Invalid capacity";
	}
	const request: ProposalAsk = {
		projectId,
		sprintId,
		variant: (variant as SprintProposalVariant | undefined) ?? "balanced",
	};
	if (typeof goal === "string" && goal.trim()) request.goal = goal.trim();
	if (typeof capacity === "number") request.capacity = capacity;
	return request;
}

interface Board {
	projectDir: string;
	tasks: Task[];
	sprints: Sprint[];
}

async function boardOf(projectId: string): Promise<Board | string> {
	const server = getServerProject(projectId);
	if (server) {
		const [remote, sprints] = await Promise.all([getRemoteTasks(server), listServerSprints(projectId)]);
		if (!remote.success || !remote.data || !sprints.success || !sprints.data) return "server_unreachable";
		return { projectDir: server.path, tasks: remote.data, sprints: sprints.data };
	}
	const project = projectStore.getProject(projectId);
	if (!project) return "Unknown project";
	return { projectDir: project.path, tasks: projectStore.getTasks(project.id), sprints: await readLocalSprints(project) };
}

function completionIn(projectDir: string): CompletionFn {
	return (prompt, systemPrompt, label) =>
		runOneShotLLM({ prompt, systemPrompt, projectDir, timeoutMs: COMPLETION_TIMEOUT_MS, debugLabel: label });
}

/**
 * The proposal for a sprint. `complete` stands in for the person's model in
 * tests; null asks the rules alone.
 */
export async function handleProposeSprint(
	raw: unknown,
	complete?: CompletionFn | null,
	now: () => number = Date.now,
): Promise<IPCResult<SprintProposal>> {
	const request = parseSprintProposalRequest(raw);
	if (typeof request === "string") return { success: false, error: request };
	const board = await boardOf(request.projectId);
	if (typeof board === "string") return { success: false, error: board };
	const sprint = board.sprints.find((item) => item.id === request.sprintId);
	if (!sprint) return { success: false, error: "not_found" };
	if (sprint.state === "closed") return { success: false, error: "closed" };

	const data = await proposeSprint({
		tasks: board.tasks,
		sprintId: sprint.id,
		capacity: request.capacity ?? sprintCapacity(sprint, board.sprints).points,
		variant: request.variant,
		goal: request.goal ?? sprint.goal,
		now: now(),
		committed: sprintProgress(board.tasks, sprint.id).points,
		appLanguage: getAppLanguage(),
		complete: complete === null ? undefined : (complete ?? completionIn(board.projectDir)),
	});
	return { success: true, data };
}

export function registerSprintProposalHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.SPRINTS_PROPOSE, (_, request: unknown) => handleProposeSprint(request));
}
