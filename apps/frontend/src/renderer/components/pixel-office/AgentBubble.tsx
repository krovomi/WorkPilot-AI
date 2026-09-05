/**
 * AgentBubble — Interactive comic-style speech bubble overlay.
 *
 * Appears when the user clicks an agent in the Pixel Office canvas.
 * Handles terminal agents, Kanban task agents and swarm subtask agents.
 */

import {
	BookOpen,
	Check,
	ChevronDown,
	ChevronRight,
	ClipboardList,
	CircleCheck,
	CircleX,
	Cog,
	Copy,
	FolderOpen,
	GitBranch,
	Hourglass,
	KeyRound,
	LayoutDashboard,
	type LucideIcon,
	Maximize2,
	MessageCircle,
	Moon,
	PenLine,
	Play,
	Plus,
	PowerOff,
	ScanSearch,
	Send,
	Square,
	Terminal as TerminalIcon,
	Wrench,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { stripAnsiCodes } from "../../../shared/utils/ansi-sanitizer";
import { flattenTaskLogsToLines } from "../../../shared/utils/task-logs";
import type { PixelAgent } from "../../stores/pixel-office-store";
import { useTaskStore } from "../../stores/task-store";
import type { Terminal } from "../../stores/terminal-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * Phase and activity icons.
 *
 * These were emoji. Emoji are a font, not a glyph guarantee: on a Linux desktop
 * without an emoji font installed — and inside the app's pixel/mono stack on
 * every platform — they render as tofu boxes, which is exactly what the office
 * header and this bubble were showing. Lucide draws SVG, so the icon is the
 * same on Windows, macOS and Linux and scales with the text around it.
 */
const PHASE_ICONS: Record<string, LucideIcon> = {
	idle: Moon,
	planning: ClipboardList,
	coding: PenLine,
	qa_review: ScanSearch,
	qa_fixing: Wrench,
	rate_limit_paused: Hourglass,
	auth_failure_paused: KeyRound,
	complete: CircleCheck,
	failed: CircleX,
};

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
	typing: PenLine,
	running: Cog,
	reading: BookOpen,
	waiting: MessageCircle,
	idle: Moon,
	exited: PowerOff,
	pending: Hourglass,
};

const ACTIVITY_COLORS: Record<string, { color: string; bgColor: string }> = {
	typing: { color: "#4A90D9", bgColor: "rgba(74,144,217,0.12)" },
	running: { color: "#1ABC9C", bgColor: "rgba(26,188,156,0.12)" },
	reading: { color: "#27AE60", bgColor: "rgba(39,174,96,0.12)" },
	waiting: { color: "#F39C12", bgColor: "rgba(243,156,18,0.12)" },
	idle: { color: "#6B7280", bgColor: "rgba(107,114,128,0.12)" },
	exited: { color: "#E74C3C", bgColor: "rgba(231,76,60,0.12)" },
	pending: { color: "#8B5CF6", bgColor: "rgba(139,92,246,0.12)" },
};

const PHASE_COLOR: Record<string, string> = {
	planning: "#27AE60",
	coding: "#4A90D9",
	qa_review: "#9B59B6",
	qa_fixing: "#E67E22",
	rate_limit_paused: "#F39C12",
	auth_failure_paused: "#E74C3C",
	complete: "#2ECC71",
	failed: "#E74C3C",
	idle: "#6B7280",
};

function getAgentColor(agent: PixelAgent): string {
	if (agent.activity === "pending") return "#8B5CF6";
	if (agent.type === "task")
		return PHASE_COLOR[agent.phase ?? "idle"] ?? "#6B7280";
	return ACTIVITY_COLORS[agent.activity]?.color ?? "#6B7280";
}

// ── Syntax-highlighted inline code chip ──────────────────────

function CodeChip({ text }: { readonly text: string }) {
	return (
		<span
			className="inline-block font-mono text-[10px] px-1.5 py-0.5 rounded"
			style={{ background: "rgba(99,102,241,0.15)", color: "#818CF8" }}
		>
			{text}
		</span>
	);
}

/** Icon + code chip pair used for the terminal's cwd, session and branch. */
function MetaChip({
	icon: Icon,
	label,
	text,
}: {
	readonly icon: LucideIcon;
	readonly label: string;
	readonly text: string;
}) {
	return (
		<span className="flex items-center gap-1" title={label}>
			<Icon className="h-3 w-3 shrink-0" aria-hidden />
			<span className="sr-only">{label}</span>
			<CodeChip text={text} />
		</span>
	);
}

// ── Progress bar ──────────────────────────────────────────────

function ProgressBar({
	value,
	color,
}: {
	readonly value: number;
	readonly color: string;
}) {
	return (
		<div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
			<div
				className="h-full rounded-full transition-all duration-500"
				style={{ width: `${Math.max(2, value)}%`, background: color }}
			/>
		</div>
	);
}

// ── Live log stream ───────────────────────────────────────────

const LOG_KEEP = 5000;

function logLineColor(line: string): string {
	if (/\[ERROR\]|error:/i.test(line) || /\bError\b/.test(line))
		return "#F87171";
	if (/\[WARN\]|warning/i.test(line)) return "#FCD34D";
	if (line.startsWith("✅") || /\[OK\]|\bsuccess\b/i.test(line))
		return "#6EE7B7";
	if (/\[INFO\]/.test(line)) return "rgba(255,255,255,0.65)";
	return "rgba(255,255,255,0.42)";
}

function LogStream({ taskId }: { readonly taskId: string }) {
	const { t } = useTranslation(["pixelOffice"]);
	const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId));
	const liveLogs = task?.logs ?? [];
	const specId = task?.specId;
	const projectId = task?.projectId;
	const [open, setOpen] = useState(true);
	const [copied, setCopied] = useState(false);
	const [persistedLines, setPersistedLines] = useState<string[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);

	// A finished task streams no live logs into `task.logs` (that array is only
	// filled while the pipeline runs). Fall back to the persisted phase logs
	// (task_logs.json) — the same source the Kanban's Logs tab reads — so the
	// bubble isn't stuck on "waiting for logs" for a completed task.
	const hasLiveLogs = liveLogs.length > 0;
	useEffect(() => {
		if (hasLiveLogs || !projectId || !specId) return;
		let cancelled = false;
		window.electronAPI
			.getTaskLogs(projectId, specId)
			.then((res) => {
				if (!cancelled && res.success && res.data) {
					setPersistedLines(flattenTaskLogsToLines(res.data));
				}
			})
			.catch(() => {
				/* best-effort: bubble simply shows no logs */
			});
		return () => {
			cancelled = true;
		};
	}, [hasLiveLogs, projectId, specId]);

	const sourceLines = hasLiveLogs ? liveLogs : persistedLines;
	const visibleLines = sourceLines
		.slice(-LOG_KEEP)
		.map((l) => stripAnsiCodes(l).trim())
		.filter((l) => l.length > 0);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
	};

	useEffect(() => {
		if (open && atBottomRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [open]);

	const copyLogs = useCallback(() => {
		navigator.clipboard.writeText(visibleLines.join("\n")).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}, [visibleLines]);

	const lastLine = visibleLines.at(-1);

	return (
		<div
			className="flex flex-col flex-1 min-h-0"
			style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
		>
			{/* Toggle header */}
			<div className="flex items-center justify-between px-4 py-2 shrink-0">
				<button
					type="button"
					className="flex items-center gap-1.5 text-[11px] text-white/50 hover:text-white/80 transition-colors font-mono"
					onClick={() => setOpen((v) => !v)}
				>
					<TerminalIcon className="h-3.5 w-3.5" />
					<span>{t("pixelOffice:bubble.logs")}</span>
					{visibleLines.length > 0 && (
						<span className="px-1.5 py-0.5 rounded text-[10px] bg-white/10 text-white/50">
							{visibleLines.length}
						</span>
					)}
					<ChevronDown
						className="h-3 w-3 transition-transform ml-0.5"
						style={{ transform: open ? "rotate(180deg)" : "none" }}
					/>
				</button>

				{visibleLines.length > 0 && (
					<button
						type="button"
						onClick={copyLogs}
						className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded transition-all"
						style={{
							color: copied ? "#6EE7B7" : "rgba(255,255,255,0.35)",
							background: copied
								? "rgba(110,231,183,0.12)"
								: "rgba(255,255,255,0.06)",
							border: `1px solid ${copied ? "rgba(110,231,183,0.3)" : "rgba(255,255,255,0.08)"}`,
						}}
						title={t("pixelOffice:bubble.copyAll")}
					>
						{copied ? (
							<>
								<Check className="h-3 w-3" /> {t("pixelOffice:bubble.copied")}
							</>
						) : (
							<>
								<Copy className="h-3 w-3" /> {t("pixelOffice:bubble.copy")}
							</>
						)}
					</button>
				)}
			</div>

			{/* Last line preview (collapsed) */}
			{!open && lastLine && (
				<div className="px-4 pb-2.5 shrink-0">
					<p
						className="text-[10px] font-mono truncate"
						style={{ color: logLineColor(lastLine) }}
					>
						{lastLine}
					</p>
				</div>
			)}

			{/* Expanded log area — flex-1 fills remaining space */}
			{open && (
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="mx-3 mb-3 rounded-xl overflow-y-auto flex-1 min-h-0"
					style={{
						background: "rgba(0,0,0,0.55)",
						border: "1px solid rgba(255,255,255,0.10)",
						scrollbarWidth: "thin",
						scrollbarColor: "rgba(255,255,255,0.2) transparent",
					}}
				>
					{visibleLines.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full gap-2 text-white/20">
							<TerminalIcon className="h-5 w-5" />
							<p className="text-[10px] font-mono">
								{t("pixelOffice:bubble.waitingForLogs")}
							</p>
						</div>
					) : (
						<div className="p-3 space-y-1">
							{visibleLines.map((line, i) => (
								<p
									// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
									key={`${line}-${i}`}
									className="text-[11px] font-mono leading-relaxed break-all"
									style={{ color: logLineColor(line) }}
								>
									{line}
								</p>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── Pending task panel (planning/queued) ──────────────────────

function PendingTaskPanel({
	onGoToTask,
	onClose,
}: {
	readonly onGoToTask: () => void;
	readonly onClose: () => void;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	return (
		<div className="flex flex-col flex-1 min-h-0">
			<div className="px-4 py-4 flex-1">
				<p className="text-xs text-white/75 leading-relaxed">
					{t("pixelOffice:pending.description")}
				</p>
				<div
					className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-mono"
					style={{
						background: "rgba(139,92,246,0.1)",
						border: "1px solid rgba(139,92,246,0.25)",
						color: "rgba(196,181,253,0.8)",
					}}
				>
					<Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden />
					<span>{t("pixelOffice:pending.hint")}</span>
				</div>
			</div>
			<div
				className="flex gap-1.5 px-4 pb-4 shrink-0"
				style={{
					borderTop: "1px solid rgba(255,255,255,0.06)",
					paddingTop: "10px",
					marginTop: "2px",
				}}
			>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2.5 text-[11px] text-white/60 hover:text-white hover:bg-white/10"
					onClick={onGoToTask}
				>
					<LayoutDashboard className="h-3 w-3 mr-1" />
					{t("pixelOffice:bubble.goToKanban")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2.5 text-[11px] text-white/40 hover:text-white/60 ml-auto"
					onClick={onClose}
				>
					<X className="h-3 w-3 mr-1" />
					{t("pixelOffice:bubble.close")}
				</Button>
			</div>
		</div>
	);
}

// ── Task agent panel ──────────────────────────────────────────

function TaskPanel({
	agent,
	color,
	onGoToTask,
	onStopTask,
	onClose,
}: {
	readonly agent: PixelAgent;
	readonly color: string;
	readonly onGoToTask: () => void;
	readonly onStopTask: () => void;
	readonly onClose: () => void;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	const taskId = agent.taskId ?? "";
	const phase = agent.phase ?? "idle";
	const isRunning = agent.activity !== "idle" && agent.activity !== "exited";
	const isPaused =
		phase === "rate_limit_paused" || phase === "auth_failure_paused";

	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Phase status — fixed */}
			<div className="px-4 py-3 shrink-0">
				<p className="text-xs text-white/75 leading-relaxed">
					{t([
						`pixelOffice:phaseDescription.${phase}`,
						"pixelOffice:phaseDescription.idle",
					])}
				</p>
				{agent.currentSubtask && (
					<div className="mt-2 flex items-start gap-1.5 text-xs">
						<ChevronRight className="h-3 w-3 text-white/40 mt-0.5 shrink-0" />
						<span className="text-white/60 font-mono leading-relaxed">
							{agent.currentSubtask}
						</span>
					</div>
				)}
			</div>

			{/* Progress — fixed */}
			{agent.progress !== undefined && (
				<div className="px-4 pb-3 shrink-0">
					<div className="flex justify-between text-[10px] text-white/40 font-mono mb-1.5">
						<span>{t("pixelOffice:bubble.progress")}</span>
						<span>{Math.round(agent.progress)}%</span>
					</div>
					<ProgressBar value={agent.progress} color={color} />
				</div>
			)}

			{/* Live log stream — expands to fill remaining space */}
			{taskId && <LogStream taskId={taskId} />}

			{/* Actions — fixed */}
			<div
				className="flex flex-wrap gap-1.5 px-4 pb-4 shrink-0"
				style={{
					borderTop: "1px solid rgba(255,255,255,0.06)",
					paddingTop: "10px",
					marginTop: "2px",
				}}
			>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2.5 text-[11px] text-white/60 hover:text-white hover:bg-white/10"
					onClick={onGoToTask}
				>
					<LayoutDashboard className="h-3 w-3 mr-1" />
					{t("pixelOffice:bubble.goToKanban")}
				</Button>

				{isRunning && !isPaused && (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2.5 text-[11px] text-red-400/70 hover:text-red-300 hover:bg-red-400/10 ml-auto"
						onClick={onStopTask}
					>
						<Square className="h-3 w-3 mr-1" />
						{t("pixelOffice:bubble.stopTask")}
					</Button>
				)}

				{!isRunning && (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2.5 text-[11px] text-white/40 hover:text-white/60 ml-auto"
						onClick={onClose}
					>
						<X className="h-3 w-3 mr-1" />
						{t("pixelOffice:bubble.close")}
					</Button>
				)}
			</div>
		</div>
	);
}

// ── Terminal agent panel ──────────────────────────────────────

function TerminalPanel({
	agent,
	terminal,
	onGoToTerminal,
	onKill,
	onInterrupt,
	onResumeClaude,
	onSendCommand,
}: {
	readonly agent: PixelAgent;
	readonly terminal: Terminal | undefined;
	readonly onGoToTerminal: () => void;
	readonly onKill: () => void;
	readonly onInterrupt: () => void;
	readonly onResumeClaude: () => void;
	readonly onSendCommand: (cmd: string) => void;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	const [command, setCommand] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const palette = ACTIVITY_COLORS[agent.activity] ?? ACTIVITY_COLORS.idle;
	const isExited = agent.activity === "exited";
	const isBusy = agent.activity === "typing" || agent.activity === "running";
	const isWaiting = agent.activity === "waiting";

	// The two activities whose copy names the task read better with it, and fall
	// back to a generic line when the terminal is not attached to one.
	const describesTask =
		agent.taskName &&
		(agent.activity === "typing" || agent.activity === "reading");
	const description = describesTask
		? t(`pixelOffice:activityDescription.${agent.activity}WithTask`, {
				task: agent.taskName,
			})
		: t([
				`pixelOffice:activityDescription.${agent.activity}`,
				"pixelOffice:activityDescription.idle",
			]);

	useEffect(() => {
		if (!isExited) setTimeout(() => inputRef.current?.focus(), 50);
	}, [isExited]);

	const handleSend = () => {
		const trimmed = command.trim();
		if (!trimmed) return;
		onSendCommand(trimmed);
		setCommand("");
	};

	return (
		<>
			{/* Description */}
			<div className="px-4 py-3">
				<p className="text-xs text-white/75 leading-relaxed">{description}</p>

				{agent.taskName && (
					<div className="mt-2 flex items-center gap-1.5 text-xs text-white/50">
						<MetaChip
							icon={ClipboardList}
							label={t("pixelOffice:bubble.taskLabel")}
							text={agent.taskName}
						/>
					</div>
				)}

				{terminal && (
					<div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-white/40 font-mono">
						{terminal.cwd && (
							<MetaChip
								icon={FolderOpen}
								label={t("pixelOffice:bubble.cwdLabel")}
								text={terminal.cwd.split(/[\\/]/).slice(-2).join("/")}
							/>
						)}
						{terminal.claudeSessionId && (
							<MetaChip
								icon={KeyRound}
								label={t("pixelOffice:bubble.sessionLabel")}
								text={`${terminal.claudeSessionId.slice(0, 8)}…`}
							/>
						)}
						{terminal.worktreeConfig && (
							<MetaChip
								icon={GitBranch}
								label={t("pixelOffice:bubble.branchLabel")}
								text={terminal.worktreeConfig.branchName}
							/>
						)}
					</div>
				)}
			</div>

			{/* Command input */}
			{!isExited && (
				<div className="px-4 pb-3">
					<div className="flex gap-2">
						<input
							ref={inputRef}
							type="text"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleSend()}
							placeholder={
								isWaiting
									? t("pixelOffice:bubble.sendPlaceholderWaiting")
									: t("pixelOffice:bubble.sendPlaceholder")
							}
							className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/30 font-mono focus:outline-none focus:border-white/30"
						/>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 px-2.5 text-xs"
							style={{ background: palette.bgColor, color: palette.color }}
							onClick={handleSend}
							disabled={!command.trim()}
							title={t("pixelOffice:bubble.send")}
						>
							<Send className="h-3 w-3" />
						</Button>
					</div>
					{isWaiting && (
						<p className="text-[10px] text-white/30 mt-1 font-mono">
							{t("pixelOffice:bubble.sendHint")}
						</p>
					)}
				</div>
			)}

			{/* Actions */}
			<div
				className="flex flex-wrap gap-1.5 px-4 pb-4"
				style={{
					borderTop: "1px solid rgba(255,255,255,0.06)",
					paddingTop: "10px",
					marginTop: "2px",
				}}
			>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 px-2.5 text-[11px] text-white/60 hover:text-white hover:bg-white/10"
					onClick={onGoToTerminal}
				>
					<Maximize2 className="h-3 w-3 mr-1" />
					{t("pixelOffice:bubble.viewTerminal")}
				</Button>

				{isBusy && (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2.5 text-[11px] text-amber-400/80 hover:text-amber-300 hover:bg-amber-400/10"
						onClick={onInterrupt}
					>
						<Square className="h-3 w-3 mr-1" />
						{t("pixelOffice:bubble.interrupt")}
					</Button>
				)}

				{!isBusy && terminal?.isClaudeMode && !isExited && (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2.5 text-[11px] text-orange-400/80 hover:text-orange-300 hover:bg-orange-400/10"
						onClick={onResumeClaude}
					>
						<Play className="h-3 w-3 mr-1" />
						{t("pixelOffice:bubble.resumeClaude")}
					</Button>
				)}

				{!isExited && (
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2.5 text-[11px] text-red-400/70 hover:text-red-300 hover:bg-red-400/10 ml-auto"
						onClick={onKill}
					>
						<X className="h-3 w-3 mr-1" />
						{t("pixelOffice:bubble.kill")}
					</Button>
				)}
			</div>
		</>
	);
}

// ── Main component ────────────────────────────────────────────

export interface AgentBubbleProps {
	readonly agent: PixelAgent;
	readonly terminal: Terminal | undefined;
	readonly anchorX: number;
	readonly anchorY: number;
	readonly onClose: () => void;
	readonly onGoToTerminal: () => void;
	readonly onGoToTask: () => void;
	readonly onKill: () => void;
	readonly onInterrupt: () => void;
	readonly onResumeClaude: () => void;
	readonly onSendCommand: (cmd: string) => void;
	readonly onStopTask: () => void;
}

export function AgentBubble({
	agent,
	terminal,
	anchorX,
	anchorY,
	onClose,
	onGoToTerminal,
	onGoToTask,
	onKill,
	onInterrupt,
	onResumeClaude,
	onSendCommand,
	onStopTask,
}: AgentBubbleProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const bubbleRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		globalThis.addEventListener("keydown", handler);
		return () => globalThis.removeEventListener("keydown", handler);
	}, [onClose]);

	const color = getAgentColor(agent);
	const top = Math.round(anchorY) + 16;
	// Arrow points up to the agent: clamp so it stays within the bubble bounds
	const arrowLeft = Math.max(
		20,
		Math.min(anchorX - 16, (globalThis.innerWidth ?? 1200) - 32 - 20),
	);

	const isTaskAgent = agent.type === "task";
	const isSwarmAgent = agent.type === "swarm";
	const isPending = agent.activity === "pending";

	// Header: what the agent is doing, and the icon that says it at a glance.
	let HeaderIcon: LucideIcon;
	let headerLabel: string;

	if (isPending) {
		HeaderIcon = ACTIVITY_ICONS.pending;
		headerLabel = t("pixelOffice:activity.pending");
	} else if (isTaskAgent) {
		const phase = agent.phase ?? "idle";
		HeaderIcon = PHASE_ICONS[phase] ?? PHASE_ICONS.idle;
		headerLabel = t([`pixelOffice:phase.${phase}`, "pixelOffice:phase.idle"]);
	} else {
		HeaderIcon = ACTIVITY_ICONS[agent.activity] ?? ACTIVITY_ICONS.idle;
		headerLabel = t([
			`pixelOffice:activity.${agent.activity}`,
			"pixelOffice:activity.idle",
		]);
	}

	// Determine which panel to render based on agent state
	const bodyPanel = (() => {
		if (isPending) {
			return <PendingTaskPanel onGoToTask={onGoToTask} onClose={onClose} />;
		}

		// A swarm subtask has progress and logs like a task, but no Kanban card of
		// its own to jump to — it belongs to the run its parent task is driving.
		if (isTaskAgent || isSwarmAgent) {
			return (
				<TaskPanel
					agent={agent}
					color={color}
					onGoToTask={onGoToTask}
					onStopTask={onStopTask}
					onClose={onClose}
				/>
			);
		}

		return (
			<TerminalPanel
				agent={agent}
				terminal={terminal}
				onGoToTerminal={onGoToTerminal}
				onKill={onKill}
				onInterrupt={onInterrupt}
				onResumeClaude={onResumeClaude}
				onSendCommand={onSendCommand}
			/>
		);
	})();

	return (
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: stop-propagation on dialog container
		<div
			ref={bubbleRef}
			role="dialog"
			aria-modal="false"
			aria-label={agent.fullName}
			className="absolute z-50 select-none flex flex-col"
			style={{ left: 16, right: 16, top, bottom: 16 }}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			{/* Arrow pointing up to the clicked agent */}
			<div style={{ paddingLeft: arrowLeft, lineHeight: 0 }}>
				<div
					className="w-0 h-0 inline-block"
					style={{
						borderLeft: "10px solid transparent",
						borderRight: "10px solid transparent",
						borderBottom: `10px solid ${color}60`,
					}}
				/>
			</div>

			<div
				className="rounded-2xl shadow-2xl border border-white/10 flex flex-col min-h-0 flex-1"
				style={{
					background: "linear-gradient(135deg, #1A1A2E 0%, #16213E 100%)",
					boxShadow: `0 0 0 2px ${color}40, 0 20px 60px rgba(0,0,0,0.5)`,
				}}
			>
				<div
					className="flex items-center justify-between px-5 py-4 shrink-0"
					style={{
						borderBottom: `1px solid ${color}30`,
						background: `${color}15`,
					}}
				>
					<div className="flex items-center gap-3 min-w-0">
						<HeaderIcon
							className="h-6 w-6 shrink-0"
							style={{ color }}
							aria-hidden
						/>
						<span className="font-mono font-bold text-xl text-white leading-tight truncate">
							{agent.fullName}
						</span>

						{isTaskAgent && (
							<Badge
								variant="outline"
								className="text-xs px-2 py-0.5 border-orange-500/50 text-orange-400 shrink-0"
							>
								<LayoutDashboard className="h-3 w-3 mr-1" />
								{t("pixelOffice:bubble.kanbanBadge")}
							</Badge>
						)}
						{isSwarmAgent && (
							<Badge
								variant="outline"
								className="text-xs px-2 py-0.5 border-violet-500/50 text-violet-300 shrink-0"
							>
								<GitBranch className="h-3 w-3 mr-1" />
								{t("pixelOffice:bubble.swarmBadge")}
							</Badge>
						)}
						{agent.isClaudeMode && !isTaskAgent && !isSwarmAgent && (
							<Badge
								variant="outline"
								className="text-xs px-2 py-0.5 border-orange-500/50 text-orange-400 shrink-0"
							>
								<Zap className="h-3 w-3 mr-1" />
								{t("pixelOffice:bubble.claudeBadge")}
							</Badge>
						)}
					</div>

					<div className="flex items-center gap-2 shrink-0 ml-3">
						<span
							className="text-sm font-mono font-semibold px-3 py-1 rounded-full"
							style={{
								background: `${color}20`,
								color: color,
								border: `1px solid ${color}50`,
							}}
						>
							{headerLabel}
						</span>
						<button
							type="button"
							onClick={onClose}
							aria-label={t("pixelOffice:bubble.close")}
							className="text-white/40 hover:text-white/80 transition-colors rounded-full w-7 h-7 flex items-center justify-center"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</div>
				<div className="flex flex-col flex-1 min-h-0">{bodyPanel}</div>
			</div>
		</div>
	);
}

// ── Add Agent Button ──────────────────────────────────────────

export function AddAgentButton({
	onClick,
	disabled,
}: {
	readonly onClick: () => void;
	readonly disabled?: boolean;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	return (
		<Button
			variant="outline"
			size="sm"
			className="h-8 px-3 text-xs font-mono border-dashed border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-400"
			onClick={onClick}
			disabled={disabled}
		>
			<Plus className="h-3.5 w-3.5 mr-1.5" />
			{t("pixelOffice:toolbar.addAgent")}
		</Button>
	);
}
