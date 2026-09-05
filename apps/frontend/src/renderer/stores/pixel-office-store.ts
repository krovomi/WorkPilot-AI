import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	calculateProgress,
	isTaskEffectivelyComplete,
} from "../../shared/progress";
import type {
	SubtaskNode,
	SubtaskState as SwarmSubtaskState,
} from "../../shared/types/swarm";
import type { ExecutionPhase, Task } from "../../shared/types/task";
import { getDisplayProgress } from "../lib/utils";
import type { Terminal } from "./terminal-store";

// ── Types ────────────────────────────────────────────────────

export type AgentActivity =
	| "idle"
	| "typing"
	| "reading"
	| "running"
	| "waiting"
	| "pending"
	| "exited";
export type PixelAgentType = "terminal" | "task" | "swarm";

/** Seat value for an agent that is queued rather than seated. */
export const NO_SEAT = -1;

export interface PixelAgent {
	id: string; // Terminal ID or Task ID
	type: PixelAgentType; // Source of this agent
	name: string; // Short display name (canvas label, ≤16 chars)
	fullName: string; // Full untruncated name (used in bubble header)
	characterIndex: number; // Which character sprite to use (0-5)
	activity: AgentActivity; // Current visual activity
	seatIndex: number; // Which desk the agent sits at (NO_SEAT when queued)
	isClaudeMode: boolean; // Whether in Claude mode (terminals) / always true for tasks
	// Task-specific fields
	taskId?: string; // Kanban task ID (for type === 'task')
	phase?: ExecutionPhase; // Current execution phase
	progress?: number; // Overall progress 0-100
	currentSubtask?: string; // Current subtask description
	// Terminal-specific fields
	taskName?: string; // Associated task name (for speech bubble)
	speechBubble?: string; // Text to show in canvas speech bubble
	speechBubbleTimer?: number; // Auto-dismiss timer
	// Waiting queue fields
	waitingIndex?: number; // Position in the waiting queue (pending/planning tasks only)
	// Swarm fields
	swarmWaveIndex?: number; // Wave this agent belongs to (swarm mode)
	swarmSubtaskId?: string; // Subtask ID (swarm mode)
}

export interface PixelOfficeSettings {
	zoom: number;
	showGrid: boolean;
	soundEnabled: boolean;
	autoAssignSeats: boolean;
}

/**
 * Something happened that the user would want to hear about.
 *
 * Upstream (pixel-agents) chimes when an agent finishes its turn or asks for
 * permission, and that is the whole point of a room you leave running on a
 * second monitor: the office tells you when it needs you, so you do not have to
 * watch it. `soundEnabled` has been in the settings object since the feature
 * shipped with nothing reading it.
 */
export type OfficeSignal = "needs-input" | "turn-done" | "failed";

export type OfficeSignalListener = (
	signal: OfficeSignal,
	agent: PixelAgent,
) => void;

const signalListeners = new Set<OfficeSignalListener>();

/** Subscribe to office signals. Returns the unsubscribe function. */
export function onOfficeSignal(listener: OfficeSignalListener): () => void {
	signalListeners.add(listener);
	return () => {
		signalListeners.delete(listener);
	};
}

function emitSignal(signal: OfficeSignal, agent: PixelAgent): void {
	for (const listener of signalListeners) {
		try {
			listener(signal, agent);
		} catch {
			// A misbehaving listener must not take the sync down with it — the
			// agents on screen matter more than the chime that goes with them.
		}
	}
}

const ACTIVE_ACTIVITIES: ReadonlySet<AgentActivity> = new Set<AgentActivity>([
	"typing",
	"running",
	"reading",
]);

/**
 * Compare one agent's activity before and after a sync and report the
 * transitions worth a sound.
 *
 * Only transitions: an agent that is *already* waiting when you open the view
 * has not just asked for anything, and a room that chimes six times on mount
 * gets muted within the minute. Agents seen for the first time are silent for
 * the same reason.
 */
function signalFor(
	previous: PixelAgent | undefined,
	next: PixelAgent,
): OfficeSignal | null {
	if (!previous || previous.activity === next.activity) return null;
	if (next.activity === "waiting") return "needs-input";
	if (next.activity === "exited" && previous.activity !== "pending")
		return "failed";
	if (next.activity === "idle" && ACTIVE_ACTIVITIES.has(previous.activity))
		return "turn-done";
	return null;
}

interface PixelOfficeState {
	agents: PixelAgent[];
	selectedAgentId: string | null;
	settings: PixelOfficeSettings;
	nextCharacterIndex: number;

	// Actions
	syncAll: (terminals: Terminal[], tasks: Task[]) => void;
	/** Sync swarm agents from wave/subtask data */
	syncSwarmAgents: (
		nodes: Record<string, SubtaskNode>,
		currentWave?: number,
	) => void;
	/** Drop every swarm character (the run ended, or swarm mode was turned off) */
	clearSwarmAgents: () => void;
	/** @deprecated use syncAll */
	syncFromTerminals: (terminals: Terminal[]) => void;
	selectAgent: (id: string | null) => void;
	/** Move the selection to the next/previous seated agent (keyboard nav) */
	cycleSelection: (direction: 1 | -1) => string | null;
	updateSettings: (updates: Partial<PixelOfficeSettings>) => void;
	setSpeechBubble: (agentId: string, text: string | undefined) => void;
}

// ── Activity mapping ──────────────────────────────────────────

function mapTerminalToActivity(terminal: Terminal): AgentActivity {
	if (terminal.status === "exited") return "exited";
	if (terminal.isClaudeBusy) return "typing";
	if (terminal.isClaudeMode && terminal.status === "claude-active") {
		return terminal.isClaudeBusy ? "typing" : "waiting";
	}
	if (terminal.status === "running") return "running";
	return "idle";
}

function mapTaskToActivity(task: Task): AgentActivity {
	if (task.status === "backlog") return "pending";
	if (task.status === "error") return "exited";
	if (task.status === "human_review") return "waiting";
	const phase = task.executionProgress?.phase;
	if (!phase) return "running";
	switch (phase) {
		case "planning":
			return "reading";
		case "coding":
			return "typing";
		case "qa_review":
			return "reading";
		case "qa_fixing":
			return "typing";
		case "rate_limit_paused":
		case "auth_failure_paused":
			return "waiting";
		case "complete":
			return "idle";
		case "failed":
			return "exited";
		default:
			return "running";
	}
}

/** Task statuses that should appear in Pixel Office */
const ACTIVE_TASK_STATUSES = new Set<Task["status"]>([
	"in_progress",
	"ai_review",
	"human_review",
	"error",
	"backlog",
]);

/** Map swarm subtask state to pixel agent activity */
function mapSwarmStateToActivity(state: SwarmSubtaskState): AgentActivity {
	switch (state) {
		case "pending":
		case "queued":
			return "pending";
		case "running":
			return "typing";
		case "completed":
			return "idle";
		case "failed":
			return "exited";
		case "retrying":
			return "running";
		case "skipped":
			return "exited";
		default:
			return "waiting";
	}
}

// ── Seating ───────────────────────────────────────────────────

/**
 * Give every seated agent a desk, compactly and stably.
 *
 * Two rules, and they pull against each other. *Stable*: an agent keeps the
 * desk it already has, because a character that teleports across the room every
 * time a neighbour's terminal closes is one you cannot follow. *Compact*: the
 * seats used are always `0..n-1`, because the canvas draws that many desks and
 * an agent holding seat 9 in a four-agent office was drawn nowhere at all —
 * invisible and unclickable, which is how the old counter-based allocation
 * failed. Keeping a seat only when it is both in range and unclaimed satisfies
 * both: the office stays legible and nobody falls off the grid.
 *
 * Mutates `seatIndex`/`waitingIndex` in place on the passed agents, which are
 * freshly built objects the caller has not published yet.
 */
export function allocateSeats(agents: PixelAgent[]): PixelAgent[] {
	const seated = agents.filter((a) => a.activity !== "pending");
	const queued = agents.filter((a) => a.activity === "pending");

	const capacity = seated.length;
	const taken = new Set<number>();
	const needsSeat: PixelAgent[] = [];

	for (const agent of seated) {
		const seat = agent.seatIndex;
		if (Number.isInteger(seat) && seat >= 0 && seat < capacity && !taken.has(seat)) {
			taken.add(seat);
		} else {
			needsSeat.push(agent);
		}
	}

	let next = 0;
	for (const agent of needsSeat) {
		while (taken.has(next)) next++;
		agent.seatIndex = next;
		taken.add(next);
	}

	for (const agent of seated) agent.waitingIndex = undefined;

	queued.forEach((agent, index) => {
		agent.seatIndex = NO_SEAT;
		agent.waitingIndex = index;
	});

	return agents;
}

// ── Agent builder helpers ─────────────────────────────────────

function shortTitle(title: string): string {
	return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

function buildTerminalAgent(
	terminal: Terminal,
	existing: PixelAgent | undefined,
	nextIdx: number,
): PixelAgent {
	const name = shortTitle(terminal.title);
	const activity = mapTerminalToActivity(terminal);
	if (existing) {
		return {
			...existing,
			type: "terminal",
			name,
			fullName: terminal.title,
			activity,
			isClaudeMode: terminal.isClaudeMode,
		};
	}
	return {
		id: terminal.id,
		type: "terminal",
		name,
		fullName: terminal.title,
		characterIndex: nextIdx % 6,
		activity,
		seatIndex: NO_SEAT,
		isClaudeMode: terminal.isClaudeMode,
	};
}

function buildTaskAgent(
	task: Task,
	existing: PixelAgent | undefined,
	nextIdx: number,
): PixelAgent {
	const agentId = `task:${task.id}`;
	const name = shortTitle(task.title);
	const activity = mapTaskToActivity(task);
	const isPending = activity === "pending";
	// Mirror the Kanban's percent (getDisplayProgress) instead of the raw
	// phase-weighted overallProgress: a finished task in human_review persists
	// overallProgress=50, so the bubble would show 50% while the board shows
	// 100%. Deriving it from completed subtasks + the terminal-state check keeps
	// both views in sync.
	const executionPhase = task.executionProgress?.phase;
	const hasActiveExecution =
		!!executionPhase &&
		executionPhase !== "idle" &&
		executionPhase !== "complete" &&
		executionPhase !== "failed";
	const progress = {
		phase: executionPhase,
		progress: getDisplayProgress(
			calculateProgress(task.subtasks),
			task.executionProgress?.overallProgress,
			hasActiveExecution,
			task.subtasks.length > 0,
			isTaskEffectivelyComplete(task.status, task.reviewReason),
		),
		currentSubtask: task.executionProgress?.currentSubtask,
	};

	if (existing) {
		return {
			...existing,
			type: "task",
			name,
			fullName: task.title,
			activity,
			...progress,
			isClaudeMode: !isPending,
			taskId: task.id,
		};
	}
	return {
		id: agentId,
		type: "task",
		name,
		fullName: task.title,
		characterIndex: nextIdx % 6,
		activity,
		seatIndex: NO_SEAT,
		isClaudeMode: !isPending,
		taskId: task.id,
		taskName: task.title,
		...progress,
	};
}

function buildSwarmAgent(
	subtaskId: string,
	node: SubtaskNode,
	existing: PixelAgent | undefined,
	nextIdx: number,
): PixelAgent {
	const fullName = node.description || subtaskId;
	const activity = mapSwarmStateToActivity(node.state);
	const base = {
		type: "swarm" as const,
		name: shortTitle(fullName),
		fullName,
		activity,
		swarmWaveIndex: node.waveIndex,
		swarmSubtaskId: subtaskId,
	};
	if (existing) return { ...existing, ...base };
	return {
		id: `swarm:${subtaskId}`,
		characterIndex: nextIdx % 6,
		seatIndex: NO_SEAT,
		isClaudeMode: true,
		...base,
	};
}

// ── Store ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS: PixelOfficeSettings = {
	zoom: 3,
	showGrid: false,
	soundEnabled: false,
	autoAssignSeats: true,
};

export const usePixelOfficeStore = create<PixelOfficeState>()(
	persist(
		(set, get) => ({
			agents: [],
			selectedAgentId: null,
			nextCharacterIndex: 0,
			settings: DEFAULT_SETTINGS,

			syncAll: (terminals: Terminal[], tasks: Task[]) => {
				const state = get();
				const existingMap = new Map(state.agents.map((a) => [a.id, a]));
				let nextIdx = state.nextCharacterIndex;
				const nextAgents: PixelAgent[] = [];

				for (const terminal of terminals.filter((t) => t.status !== "exited")) {
					const existing = existingMap.get(terminal.id);
					nextAgents.push(buildTerminalAgent(terminal, existing, nextIdx));
					if (!existing) nextIdx++;
				}

				for (const task of tasks.filter((t) =>
					ACTIVE_TASK_STATUSES.has(t.status),
				)) {
					const existing = existingMap.get(`task:${task.id}`);
					nextAgents.push(buildTaskAgent(task, existing, nextIdx));
					if (!existing) nextIdx++;
				}

				// Swarm characters are owned by syncSwarmAgents — carry them through
				// so a terminal opening mid-run does not empty the swarm desks. Copies,
				// not the live objects: allocateSeats writes seat indices, and writing
				// them into state that is already published is how a re-render gets
				// skipped for a change that did happen.
				for (const agent of state.agents) {
					if (agent.type === "swarm") nextAgents.push({ ...agent });
				}

				allocateSeats(nextAgents);

				for (const agent of nextAgents) {
					const signal = signalFor(existingMap.get(agent.id), agent);
					if (signal) emitSignal(signal, agent);
				}

				set({ agents: nextAgents, nextCharacterIndex: nextIdx });
			},

			syncSwarmAgents: (nodes: Record<string, SubtaskNode>) => {
				const state = get();
				const existingMap = new Map(state.agents.map((a) => [a.id, a]));
				let nextIdx = state.nextCharacterIndex;

				const nextAgents = state.agents
					.filter((a) => a.type !== "swarm")
					.map((a) => ({ ...a }));
				for (const [subtaskId, node] of Object.entries(nodes)) {
					const existing = existingMap.get(`swarm:${subtaskId}`);
					nextAgents.push(buildSwarmAgent(subtaskId, node, existing, nextIdx));
					if (!existing) nextIdx++;
				}

				allocateSeats(nextAgents);

				for (const agent of nextAgents) {
					if (agent.type !== "swarm") continue;
					const signal = signalFor(existingMap.get(agent.id), agent);
					if (signal) emitSignal(signal, agent);
				}

				set({ agents: nextAgents, nextCharacterIndex: nextIdx });
			},

			clearSwarmAgents: () => {
				const remaining = get().agents.filter((a) => a.type !== "swarm");
				if (remaining.length === get().agents.length) return;
				set({ agents: allocateSeats(remaining.map((a) => ({ ...a }))) });
			},

			/** @deprecated use syncAll */
			syncFromTerminals: (terminals: Terminal[]) => {
				get().syncAll(terminals, []);
			},

			selectAgent: (id) => set({ selectedAgentId: id }),

			cycleSelection: (direction) => {
				const { agents, selectedAgentId } = get();
				const seated = agents
					.filter((a) => a.seatIndex >= 0)
					.sort((a, b) => a.seatIndex - b.seatIndex);
				if (seated.length === 0) return null;
				const current = seated.findIndex((a) => a.id === selectedAgentId);
				// Nothing selected yet: step forward lands on the first agent, back on
				// the last, which is what a user pressing an arrow key expects.
				const nextIndex =
					current === -1
						? direction === 1
							? 0
							: seated.length - 1
						: (current + direction + seated.length) % seated.length;
				const id = seated[nextIndex].id;
				set({ selectedAgentId: id });
				return id;
			},

			updateSettings: (updates) =>
				set((state) => ({ settings: { ...state.settings, ...updates } })),

			setSpeechBubble: (agentId, text) =>
				set((state) => ({
					agents: state.agents.map((a) =>
						a.id === agentId ? { ...a, speechBubble: text } : a,
					),
				})),
		}),
		{
			name: "pixel-office-settings",
			// Agents are rebuilt from terminals and tasks on every mount; persisting
			// them would restore a room full of characters whose terminals are long
			// gone. Only the view preferences survive a restart.
			partialize: (state) => ({ settings: state.settings }),
			merge: (persisted, current) => ({
				...current,
				settings: {
					...DEFAULT_SETTINGS,
					...((persisted as { settings?: Partial<PixelOfficeSettings> } | null)
						?.settings ?? {}),
				},
			}),
		},
	),
);
