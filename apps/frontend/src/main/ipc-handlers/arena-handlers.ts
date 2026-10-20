/**
 * Arena Mode IPC Handlers
 *
 * Runs the same prompt against several real models in parallel, streams the
 * results back anonymously (Model A / B / C / D), persists votes and computes
 * win-rate analytics and auto-routing recommendations.
 *
 * **The battle used to be a mock.** `runBattle` returned a canned paragraph per
 * task type, billed every participant at a flat $3 per million tokens, and
 * recorded each of them as `modelName: "Model A", provider: "unknown"` — so the
 * reveal revealed nothing, the rankings ranked labels, and the one thing the
 * page exists to measure was never measured. Every contestant now goes through
 * `runOneShotLLM`, which is the same provider-agnostic path the rest of the app
 * uses, with the contestant's own provider and model.
 *
 * The roster is **not** built here. Which providers are configured and which
 * models each one offers are questions the renderer already answers, for the
 * provider list and every model picker (`useArenaContenders`). A second
 * detector in the main process would be a second answer; this side runs what it
 * is handed, and refuses a request that does not name a provider and a model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { app, ipcMain } from "electron";
import type {
	ArenaAnalytics,
	ArenaBattle,
	ArenaLabel,
	ArenaModelStats,
	ArenaParticipant,
	ArenaTaskType,
	ArenaVote,
} from "../../shared/types/arena";
import { estimateTokens } from "../../shared/utils/arena-contenders";
import { appLog } from "../app-logger";
import { runOneShotLLM } from "../oneshot-llm";

// ─── Storage ──────────────────────────────────────────────────────────────────

function getArenaDataDir(): string {
	const userDataPath = app.getPath("userData");
	const dir = path.join(userDataPath, "arena-mode");
	// `recursive` already makes this a no-op on an existing directory, so the
	// `existsSync` that used to guard it bought nothing and opened the same
	// check-then-act window CodeQL flags one function below.
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function getBattlesPath(): string {
	return path.join(getArenaDataDir(), "battles.json");
}

function getVotesPath(): string {
	return path.join(getArenaDataDir(), "votes.json");
}

/**
 * Battles recorded before the arena ran real models carry no model identity at
 * all: every participant is `Model A` of provider `unknown`, and every cost is
 * the flat rate the mock invented. They cannot answer the question the
 * analytics tab asks, and counting them would put a fabricated price next to a
 * measured one. They are moved aside rather than deleted — a record nobody can
 * use is still the user's.
 *
 * The archive is created **exclusively** (`wx`) rather than written after an
 * `existsSync` check. Between that check and the write sits a window in which
 * the archive can appear — a second window of the app reading the same file,
 * or this process racing itself — and the loser of that race would overwrite
 * the very records it was called to preserve. One syscall asks and answers.
 */
function quarantineLegacy(filePath: string, records: unknown[]): void {
	const archive = filePath.replace(/\.json$/, ".pre-real-models.json");
	try {
		fs.writeFileSync(archive, JSON.stringify(records, null, 2), {
			flag: "wx",
		});
	} catch (err) {
		// EEXIST means the records are already preserved — by an earlier run or
		// by whoever won the race — so clearing the live file is still correct.
		// Anything else means nothing was preserved, so nothing is cleared: the
		// records stay where they are and the next read tries again.
		if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
			appLog.warn(`[Arena] Could not archive legacy records: ${err}`);
			return;
		}
	}
	try {
		fs.writeFileSync(filePath, "[]");
		appLog.info(
			`[Arena] ${records.length} record(s) from the simulated era moved to ${path.basename(archive)}`,
		);
	} catch (err) {
		appLog.warn(`[Arena] Could not clear legacy records: ${err}`);
	}
}

function readBattles(): ArenaBattle[] {
	const p = getBattlesPath();
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		const legacy = parsed.filter(
			(battle) =>
				!Array.isArray(battle?.participants) ||
				battle.participants.some(
					(participant: { contenderId?: unknown }) =>
						typeof participant?.contenderId !== "string",
				),
		);
		if (legacy.length > 0) {
			quarantineLegacy(p, parsed);
			return parsed.filter((battle) => !legacy.includes(battle));
		}
		return parsed;
	} catch {
		// No file yet, or one nobody can parse: an empty history either way.
		// Reading and catching is also one syscall instead of two, so the file
		// cannot be removed between the question and the read.
		return [];
	}
}

function writeBattles(battles: ArenaBattle[]): void {
	// Keep only last 100 battles
	const trimmed = battles.slice(0, 100);
	fs.writeFileSync(getBattlesPath(), JSON.stringify(trimmed, null, 2));
}

function readVotes(): ArenaVote[] {
	const p = getVotesPath();
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		const legacy = parsed.filter(
			(vote) => typeof vote?.winnerContenderId !== "string",
		);
		if (legacy.length > 0) {
			quarantineLegacy(p, parsed);
			return parsed.filter((vote) => !legacy.includes(vote));
		}
		return parsed;
	} catch {
		// No file yet, or one nobody can parse: no votes either way.
		return [];
	}
}

function writeVotes(votes: ArenaVote[]): void {
	fs.writeFileSync(getVotesPath(), JSON.stringify(votes, null, 2));
}

// ─── Analytics Builder ────────────────────────────────────────────────────────

function initializeModelStats(participant: ArenaParticipant): ArenaModelStats {
	return {
		contenderId: participant.contenderId,
		modelName: participant.modelName,
		model: participant.model,
		provider: participant.provider,
		providerLabel: participant.providerLabel,
		wins: 0,
		losses: 0,
		total: 0,
		winRate: 0,
		totalCostUsd: 0,
		costSamples: 0,
		avgDurationMs: 0,
		byTaskType: {},
	};
}

function updateModelStats(
	stats: ArenaModelStats,
	participant: ArenaParticipant,
	isWinner: boolean,
): void {
	stats.total += 1;
	if (isWinner) stats.wins += 1;
	else stats.losses += 1;
	// Only a cost the provider reported is added. An unreported one is not a
	// zero: averaging it in would quietly make an unmeasured model look free.
	if (typeof participant.costUsd === "number") {
		stats.totalCostUsd += participant.costUsd;
		stats.costSamples += 1;
	}
	stats.avgDurationMs =
		(stats.avgDurationMs * (stats.total - 1) + participant.durationMs) /
		stats.total;
}

function updateTaskTypeStats(
	stats: ArenaModelStats,
	taskType: ArenaTaskType,
	isWinner: boolean,
	costUsd: number | undefined,
): void {
	let ttStats = stats.byTaskType[taskType];
	if (!ttStats) {
		ttStats = { wins: 0, total: 0, winRate: 0, costSamples: 0 };
		stats.byTaskType[taskType] = ttStats;
	}
	ttStats.total += 1;
	if (isWinner) ttStats.wins += 1;
	ttStats.winRate = ttStats.wins / ttStats.total;
	if (typeof costUsd === "number") {
		const previousTotal = (ttStats.avgCostUsd ?? 0) * ttStats.costSamples;
		ttStats.costSamples += 1;
		ttStats.avgCostUsd = (previousTotal + costUsd) / ttStats.costSamples;
	}
}

function buildModelStats(battles: ArenaBattle[]): Map<string, ArenaModelStats> {
	const modelMap = new Map<string, ArenaModelStats>();

	for (const battle of battles) {
		if (battle.status !== "completed" || !battle.winnerLabel) continue;

		for (const participant of battle.participants) {
			let stats = modelMap.get(participant.contenderId);

			if (!stats) {
				stats = initializeModelStats(participant);
				modelMap.set(participant.contenderId, stats);
			}

			const isWinner = participant.label === battle.winnerLabel;
			updateModelStats(stats, participant, isWinner);
			updateTaskTypeStats(
				stats,
				battle.taskType,
				isWinner,
				participant.costUsd,
			);
		}
	}

	return modelMap;
}

function finalizeStats(modelMap: Map<string, ArenaModelStats>): void {
	for (const stats of modelMap.values()) {
		stats.winRate = stats.total > 0 ? stats.wins / stats.total : 0;
		stats.avgCostPerBattle =
			stats.costSamples > 0
				? stats.totalCostUsd / stats.costSamples
				: undefined;
	}
}

function calculateConfidence(totalBattles: number): "low" | "medium" | "high" {
	if (totalBattles >= 10) return "high";
	if (totalBattles >= 5) return "medium";
	return "low";
}

function findBestModelForTask(
	modelMap: Map<string, ArenaModelStats>,
	taskType: ArenaTaskType,
):
	| [ArenaModelStats, NonNullable<ArenaModelStats["byTaskType"][ArenaTaskType]>]
	| null {
	let bestCombo:
		| [
				ArenaModelStats,
				NonNullable<ArenaModelStats["byTaskType"][ArenaTaskType]>,
		  ]
		| null = null;
	let bestWins = 0;

	for (const stats of modelMap.values()) {
		const ttStats = stats.byTaskType[taskType];
		if (!ttStats || ttStats.total < 2) continue;

		if (ttStats.wins > bestWins) {
			bestWins = ttStats.wins;
			bestCombo = [stats, ttStats];
		}
	}

	return bestCombo;
}

function buildAutoRoutingRecommendations(
	modelMap: Map<string, ArenaModelStats>,
): ArenaAnalytics["autoRoutingRecommendations"] {
	const taskTypes: ArenaTaskType[] = [
		"coding",
		"review",
		"test",
		"planning",
		"spec",
		"insights",
	];
	const recommendations: ArenaAnalytics["autoRoutingRecommendations"] = {};

	for (const taskType of taskTypes) {
		const bestCombo = findBestModelForTask(modelMap, taskType);

		if (bestCombo) {
			const [stats, ttStats] = bestCombo;
			const confidence = calculateConfidence(ttStats.total);

			recommendations[taskType] = {
				contenderId: stats.contenderId,
				modelName: stats.modelName,
				providerLabel: stats.providerLabel,
				winRate: ttStats.winRate,
				confidence,
			};
		}
	}

	return recommendations;
}

function computeAnalytics(
	battles: ArenaBattle[],
	votes: ArenaVote[],
): ArenaAnalytics {
	const modelMap = buildModelStats(battles);
	finalizeStats(modelMap);
	const autoRoutingRecommendations = buildAutoRoutingRecommendations(modelMap);

	return {
		totalBattles: battles.length,
		totalVotes: votes.length,
		byModel: Array.from(modelMap.values()).sort(
			(a, b) => b.winRate - a.winRate,
		),
		autoRoutingRecommendations,
		lastUpdated: Date.now(),
	};
}

// ─── Battle Execution ─────────────────────────────────────────────────────────

const LABELS: ArenaLabel[] = ["A", "B", "C", "D"];

/** A battle gives a model far longer than a title generation: it is the task. */
const PARTICIPANT_TIMEOUT_MS = 5 * 60_000;

/**
 * What each task type asks for.
 *
 * Every contestant gets the **same** instruction: the arena measures the model,
 * so anything that differs between them is a confound. Kept short on purpose —
 * a long house style would measure how well a model follows the style.
 */
const TASK_SYSTEM_PROMPTS: Record<ArenaTaskType, string> = {
	coding:
		"You are a senior software engineer. Implement what is asked, as code, " +
		"in the language the request implies. Show the code first, then a short " +
		"explanation of the choices that are not obvious.",
	review:
		"You are a senior code reviewer. Report what is wrong, ordered by " +
		"severity, each finding naming the concrete failure it causes. Say so " +
		"plainly when something is fine.",
	test:
		"You are a test engineer. Write the tests the request calls for, in the " +
		"framework the code implies, covering the happy path and the edge cases " +
		"that can actually break. No commentary beyond what a reader needs.",
	planning:
		"You are a technical planner. Break the work into phases and concrete " +
		"subtasks, each one small enough to be finished and verified on its own. " +
		"No time estimates — order by dependency and priority.",
	spec: "You are a technical writer. Produce a specification: scope, " +
		"functional and non-functional requirements, and the decisions the " +
		"inputs could not settle, marked as open questions rather than guessed.",
	insights:
		"You are a software architect. Answer the question about the codebase or " +
		"design, citing the evidence behind each claim and separating what you " +
		"observed from what you inferred.",
};

interface ContenderRequest {
	id: string;
	provider: string;
	providerLabel?: string;
	model: string;
	modelLabel?: string;
}

interface StartBattleRequest {
	taskType: ArenaTaskType;
	prompt: string;
	contenders: ContenderRequest[];
	projectPath?: string;
}

interface ParticipantOutcome {
	label: ArenaLabel;
	output: string;
	tokensUsed: number;
	costUsd?: number;
	usageEstimated: boolean;
	durationMs: number;
	error?: string;
}

async function runParticipant(
	battle: ArenaBattle,
	participant: ArenaParticipant,
	request: StartBattleRequest,
	safeSend: (channel: string, ...args: unknown[]) => void,
): Promise<ParticipantOutcome> {
	const startTime = Date.now();
	let output = "";
	let reportedTokens: number | null = null;
	let reportedCost: number | undefined;
	let failure: string | null = null;

	const text = await runOneShotLLM({
		prompt: request.prompt,
		systemPrompt: TASK_SYSTEM_PROMPTS[request.taskType],
		provider: participant.provider,
		model: participant.model,
		// The one thing the arena must never do is answer for a model that did
		// not run: a provider with no adapter would be served by the Claude SDK
		// and its win recorded against its own name.
		requireProvider: true,
		projectDir: request.projectPath,
		timeoutMs: PARTICIPANT_TIMEOUT_MS,
		debugLabel: `Arena ${participant.label}`,
		onDelta: (chunk) => {
			output += chunk;
			safeSend("arena:battleProgress", {
				battleId: battle.id,
				label: participant.label,
				chunk,
			});
		},
		onUsage: (usage) => {
			reportedTokens = usage.inputTokens + usage.outputTokens;
			reportedCost = usage.costUsd;
		},
		onFailure: (reason) => {
			failure = reason;
		},
	});

	const durationMs = Date.now() - startTime;

	// A provider that does not stream returns everything here; one that does has
	// already sent it chunk by chunk, and `text` is the same content.
	const finalOutput = text ?? output;

	if (!finalOutput) {
		return {
			label: participant.label,
			output: "",
			tokensUsed: 0,
			usageEstimated: true,
			durationMs,
			error: failure ?? "No response from the provider",
		};
	}

	return {
		label: participant.label,
		output: finalOutput,
		// The provider's own count when it gave one; otherwise an estimate, and
		// the flag is what stops the UI from presenting it as a measurement.
		tokensUsed: reportedTokens ?? estimateTokens(finalOutput),
		costUsd: reportedCost,
		usageEstimated: reportedTokens === null,
		durationMs,
	};
}

async function runBattle(
	battle: ArenaBattle,
	request: StartBattleRequest,
	getMainWindow: () => BrowserWindow | null,
): Promise<void> {
	const safeSend = (channel: string, ...args: unknown[]) => {
		const w = getMainWindow();
		if (w && !w.isDestroyed()) {
			w.webContents.send(channel, ...args);
		}
	};

	// All contestants run at once — the same prompt, at the same moment, so a
	// provider having a slow minute is the only thing the durations can differ by.
	const results = await Promise.allSettled(
		battle.participants.map(async (participant) => {
			const outcome = await runParticipant(
				battle,
				participant,
				request,
				safeSend,
			);
			safeSend("arena:battleResult", {
				battleId: battle.id,
				...outcome,
			});
			return outcome;
		}),
	);

	const finalParticipants: ArenaParticipant[] = battle.participants.map(
		(p, i) => {
			const result = results[i];
			if (result.status === "fulfilled") {
				const r = result.value;
				return {
					...p,
					output: r.output,
					status: r.error ? "error" : "completed",
					tokensUsed: r.tokensUsed,
					costUsd: r.costUsd,
					usageEstimated: r.usageEstimated,
					durationMs: r.durationMs,
					error: r.error,
				};
			}
			const reason =
				result.reason instanceof Error
					? result.reason.message
					: "Unexpected failure";
			appLog.error(`[Arena] Participant ${p.label} crashed: ${reason}`);
			safeSend("arena:battleResult", {
				battleId: battle.id,
				label: p.label,
				output: "",
				tokensUsed: 0,
				usageEstimated: true,
				durationMs: 0,
				error: reason,
			});
			return { ...p, status: "error", error: reason };
		},
	);

	safeSend("arena:battleComplete", {
		battleId: battle.id,
		participants: finalParticipants,
	});

	// Persist completed (pre-vote) battle
	const battles = readBattles();
	const completedBattle: ArenaBattle = {
		...battle,
		participants: finalParticipants,
		status: "voting",
		completedAt: Date.now(),
	};
	writeBattles([completedBattle, ...battles.filter((b) => b.id !== battle.id)]);

	const failed = finalParticipants.filter((p) => p.status === "error").length;
	appLog.info(
		`[Arena] Battle ${battle.id} finished — ${finalParticipants.length - failed}/${finalParticipants.length} model(s) answered`,
	);
}

/** Refuse a contestant the battle could not actually run. */
function validateContenders(contenders: unknown): string | null {
	if (!Array.isArray(contenders) || contenders.length < 2) {
		return "At least 2 models are required for a battle";
	}
	for (const contender of contenders) {
		if (
			!contender ||
			typeof contender.provider !== "string" ||
			!contender.provider.trim() ||
			typeof contender.model !== "string" ||
			!contender.model.trim()
		) {
			return "Each contender must name a provider and a model";
		}
	}
	const ids = contenders.map(
		(c: ContenderRequest) => c.id || `${c.provider}:${c.model}`,
	);
	if (new Set(ids).size !== ids.length) {
		return "The same model cannot enter a battle twice";
	}
	return null;
}

// ─── Handler Registration ─────────────────────────────────────────────────────

export function registerArenaHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// Start a new battle
	ipcMain.handle(
		"arena:startBattle",
		async (_event, request: StartBattleRequest) => {
			try {
				const invalid = validateContenders(request?.contenders);
				if (invalid) return { success: false, error: invalid };
				if (!request.prompt?.trim()) {
					return { success: false, error: "A prompt is required" };
				}

				const battleId = `arena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

				const participants: ArenaParticipant[] = request.contenders
					.slice(0, LABELS.length)
					.map((contender, i) => ({
						label: LABELS[i],
						contenderId: contender.id || `${contender.provider}:${contender.model}`,
						provider: contender.provider,
						providerLabel: contender.providerLabel || contender.provider,
						model: contender.model,
						modelName: contender.modelLabel || contender.model,
						status: "waiting",
						output: "",
						tokensUsed: 0,
						usageEstimated: true,
						durationMs: 0,
					}));

				const battle: ArenaBattle = {
					id: battleId,
					taskType: request.taskType,
					prompt: request.prompt.trim(),
					participants,
					status: "running",
					createdAt: Date.now(),
					revealed: false,
				};

				appLog.info(
					`[Arena] Starting battle ${battleId}: ${participants
						.map((p) => `${p.provider}/${p.model}`)
						.join(" vs ")}`,
				);

				// Run in background — do not await here
				runBattle(battle, request, getMainWindow).catch((err) => {
					appLog.error(`[Arena] Battle error: ${err}`);
					const win = getMainWindow();
					if (win && !win.isDestroyed()) {
						win.webContents.send("arena:battleError", {
							battleId,
							error: err instanceof Error ? err.message : "Unknown error",
						});
					}
				});

				return { success: true, data: battle };
			} catch (err) {
				appLog.error(`[Arena] Failed to start battle: ${err}`);
				return {
					success: false,
					error: err instanceof Error ? err.message : "Unknown error",
				};
			}
		},
	);

	// Submit a vote for a battle
	ipcMain.handle("arena:vote", async (_event, vote: ArenaVote) => {
		try {
			// Update battle as completed
			const battles = readBattles();
			const battleIdx = battles.findIndex((b) => b.id === vote.battleId);

			if (battleIdx !== -1) {
				battles[battleIdx] = {
					...battles[battleIdx],
					status: "completed",
					winnerLabel: vote.winnerLabel,
					votedAt: vote.votedAt,
					revealed: true,
				};
				writeBattles(battles);
			}

			// Persist vote
			const votes = readVotes();
			votes.unshift(vote);
			writeVotes(votes);

			appLog.info(
				`[Arena] Vote recorded: battle=${vote.battleId}, winner=${vote.winnerContenderId}`,
			);
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : "Failed to save vote",
			};
		}
	});

	// Get battle history
	ipcMain.handle("arena:getBattles", async () => {
		try {
			const battles = readBattles();
			return { success: true, data: battles };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : "Failed to load battles",
			};
		}
	});

	// Get analytics
	ipcMain.handle("arena:getAnalytics", async () => {
		try {
			const battles = readBattles();
			const votes = readVotes();
			const analytics = computeAnalytics(battles, votes);
			return { success: true, data: analytics };
		} catch (err) {
			return {
				success: false,
				error:
					err instanceof Error ? err.message : "Failed to compute analytics",
			};
		}
	});

	// Clear battle history
	ipcMain.handle("arena:clearHistory", async () => {
		try {
			writeBattles([]);
			writeVotes([]);
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : "Failed to clear history",
			};
		}
	});

	appLog.info("[Arena] IPC handlers registered");
}
