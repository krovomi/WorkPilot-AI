/**
 * Pixel Office — Main component wrapping the canvas + toolbar.
 *
 * Each agent terminal, active Kanban task and running swarm subtask appears as
 * a pixel art character. Characters reflect real-time activity (typing,
 * reading, waiting, idle).
 */

import {
	Building2,
	Grid3X3,
	Hourglass,
	Tv,
	Volume2,
	VolumeX,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FAMILY_SHIRTS } from "../../lib/pixel-office-providers";
import {
	onOfficeSignal,
	type PixelAgent,
	usePixelOfficeStore,
} from "../../stores/pixel-office-store";
import { useSwarmStore } from "../../stores/swarm-store";
import { loadTasks, useTaskStore } from "../../stores/task-store";
import { useTerminalStore } from "../../stores/terminal-store";
import { Button } from "../ui/button";
import "../charter/charter.css";
import { Chip, Chips } from "../charter";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { AchievementsPanel } from "./AchievementsPanel";
import { AchievementToast } from "./AchievementToast";
import { AddAgentButton, AgentBubble } from "./AgentBubble";
import { KioskOverlay } from "./KioskOverlay";
import { NarrativeFeed } from "./NarrativeFeed";
import { OfficeScenesMenu } from "./OfficeScenesMenu";
import { ProviderLegend } from "./ProviderLegend";
import { SeasonPanel } from "./SeasonPanel";
import { closeChimes, playChime } from "./office-sounds";
import { shippedToday } from "./office-stats";
import { PixelOfficeCanvas } from "./PixelOfficeCanvas";
import { getCharacterSprite } from "./pixel-sprites";
import { useKioskMode } from "./use-kiosk-mode";
import { useOfficeAchievements } from "./use-office-achievements";
import { useOfficeCalm } from "./use-office-motion";
import { useOfficeNarratives } from "./use-office-narratives";
import { useOfficeSeason } from "./use-office-season";

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

// ── Mini pixel character (for the waiting queue) ─────────────

/** How long one bob frame lasts, in ms. */
const MINI_FRAME_MS = 700;

function MiniPixelChar({
	characterIndex,
	calm,
	shirt,
}: {
	readonly characterIndex: number;
	readonly calm: boolean;
	/** The provider family's colour, when the task names a provider. */
	readonly shirt?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		let frame = 0;

		const ctx = canvasRef.current?.getContext("2d");
		// No 2D context: the name under the character still says who it is.
		if (!ctx) return;
		const { width, height } = ctx.canvas;

		const draw = () => {
			ctx.imageSmoothingEnabled = false;
			ctx.clearRect(0, 0, width, height);
			const sprite = getCharacterSprite(characterIndex, "down", frame, shirt);
			ctx.drawImage(sprite, 0, 0, width, height);
		};

		draw();
		if (calm) return;
		// A two-frame idle bob does not need requestAnimationFrame. The old loop
		// woke sixty times a second to decide, fifty-nine of those times, that
		// 700ms had not elapsed yet — once per queued task.
		const timer = setInterval(() => {
			frame = (frame + 1) % 2;
			draw();
		}, MINI_FRAME_MS);

		return () => clearInterval(timer);
	}, [characterIndex, calm, shirt]);

	return (
		<canvas
			ref={canvasRef}
			width={16}
			height={24}
			style={{ imageRendering: "pixelated", width: 32, height: 48 }}
		/>
	);
}

// ── Waiting queue strip ───────────────────────────────────────

interface WaitingQueueProps {
	readonly agents: PixelAgent[];
	readonly onAgentClick: (agentId: string, x: number) => void;
	readonly calm: boolean;
}

function WaitingQueue({ agents, onAgentClick, calm }: WaitingQueueProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const stripRef = useRef<HTMLDivElement>(null);

	if (agents.length === 0) return null;

	return (
		<div
			ref={stripRef}
			className="absolute bottom-0 left-0 right-0 pointer-events-none"
			style={{ zIndex: 20 }}
		>
			<div
				className="mx-4 mb-3 rounded-2xl pointer-events-auto overflow-hidden"
				style={{
					background:
						"linear-gradient(to top, rgba(10,8,30,0.97) 0%, rgba(20,14,50,0.92) 100%)",
					border: "1px solid rgba(139,92,246,0.35)",
					boxShadow: "0 -4px 24px rgba(139,92,246,0.12)",
				}}
			>
				{/* Sign / header */}
				<div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
					<div
						className="w-2 h-2 rounded-full shrink-0"
						style={{
							background: "#8B5CF6",
							boxShadow: "0 0 6px #8B5CF6",
							animation: calm ? "none" : "pulse 2s ease-in-out infinite",
						}}
					/>
					<Hourglass
						className="h-3.5 w-3.5 shrink-0"
						style={{ color: "#C4B5FD" }}
						aria-hidden
					/>
					<span
						className="text-xs font-mono font-bold"
						style={{ color: "#C4B5FD" }}
					>
						{t("pixelOffice:queue.title")}
					</span>
					<span
						className="text-3xs font-mono ml-auto"
						style={{ color: "rgba(167,139,250,0.5)" }}
					>
						{t("pixelOffice:queue.count", { count: agents.length })}
					</span>
				</div>

				{/* Bench line */}
				<div
					className="mx-4 mb-2 h-px"
					style={{ background: "rgba(139,92,246,0.2)" }}
				/>

				{/* Agents queue */}
				<div
					className="flex gap-3 px-4 pb-3 overflow-x-auto"
					style={{ scrollbarWidth: "none" }}
				>
					{agents.map((agent, place) => (
						<button
							key={agent.id}
							type="button"
							className="flex flex-col items-center gap-1 group transition-opacity hover:opacity-100"
							style={{ opacity: 0.75, minWidth: 48 }}
							onClick={(e) => {
								// Measure against the strip itself, not `closest(".relative")`:
								// the nearest positioned ancestor is a Tailwind class anyone
								// could remove from a parent, and the bubble would then be
								// anchored against the viewport.
								// The button is rendered inside the strip, so the strip is
								// mounted whenever it can be clicked.
								const strip = stripRef.current as HTMLDivElement;
								const rect = e.currentTarget.getBoundingClientRect();
								const parentRect = strip.getBoundingClientRect();
								onAgentClick(
									agent.id,
									rect.left - parentRect.left + rect.width / 2,
								);
							}}
							title={agent.fullName}
						>
							{/* Slow-bob wrapper */}
							<div
								style={{
									animation: calm ? "none" : "waitBob 2.5s ease-in-out infinite",
									// Staggered by place in the queue, so the bench does not bob in step.
									animationDelay: `${place * 0.4}s`,
								}}
							>
								<MiniPixelChar
									characterIndex={agent.characterIndex}
									calm={calm}
									shirt={agent.providerFamily && FAMILY_SHIRTS[agent.providerFamily]}
								/>
							</div>
							{/* Violet glow dot */}
							<div
								className="w-1.5 h-1.5 rounded-full"
								style={{ background: "#8B5CF6", opacity: 0.7 }}
							/>
							{/* Name */}
							<span
								className="text-3xs font-mono text-center leading-tight max-w-[52px] truncate"
								style={{ color: "rgba(196,181,253,0.65)" }}
								title={agent.fullName}
							>
								{agent.name}
							</span>
						</button>
					))}
				</div>

				{/* Bench plank at the bottom */}
				<div
					className="mx-4 mb-3 rounded-lg h-2"
					style={{
						background: "linear-gradient(to bottom, #3D2A6E, #2A1A50)",
						border: "1px solid rgba(139,92,246,0.3)",
					}}
				/>
			</div>

			{/* Keyframe for bob animation injected once */}
			<style>{`
        @keyframes waitBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────

interface PixelOfficeProps {
	/** File-system path of the project — used to match terminal sessions */
	readonly projectPath: string;
	/** Project ID (UUID) — used to match Kanban tasks */
	readonly projectId: string;
	readonly onNavigateToTerminals?: () => void;
	readonly onNavigateToKanban?: () => void;
}

export function PixelOffice({
	projectPath,
	projectId,
	onNavigateToTerminals,
	onNavigateToKanban,
}: PixelOfficeProps) {
	const { t, i18n } = useTranslation(["pixelOffice", "common", "navigation"]);
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
	const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(
		null,
	);

	// ── Stores ──────────────────────────────────────────────────

	const terminals = useTerminalStore((s) => s.terminals);
	const jumpToTerminal = useTerminalStore((s) => s.jumpToTerminal);
	const addTerminal = useTerminalStore((s) => s.addTerminal);
	const removeTerminal = useTerminalStore((s) => s.removeTerminal);
	const canAddTerminal = useTerminalStore((s) => s.canAddTerminal);

	const tasks = useTaskStore((s) => s.tasks);
	const tasksLoading = useTaskStore((s) => s.isLoading);
	const selectTask = useTaskStore((s) => s.selectTask);
	const jumpToTask = useTaskStore((s) => s.jumpToTask);

	const swarmNodes = useSwarmStore((s) => s.status?.nodes);

	const agents = usePixelOfficeStore((s) => s.agents);
	const selectedAgentId = usePixelOfficeStore((s) => s.selectedAgentId);
	const settings = usePixelOfficeStore((s) => s.settings);
	const syncAll = usePixelOfficeStore((s) => s.syncAll);
	const syncSwarmAgents = usePixelOfficeStore((s) => s.syncSwarmAgents);
	const clearSwarmAgents = usePixelOfficeStore((s) => s.clearSwarmAgents);
	const selectAgent = usePixelOfficeStore((s) => s.selectAgent);
	const cycleSelection = usePixelOfficeStore((s) => s.cycleSelection);
	const updateSettings = usePixelOfficeStore((s) => s.updateSettings);

	// ── Sync terminals + tasks → pixel agents ───────────────────

	useEffect(() => {
		const projectTerminals = terminals.filter(
			(t) => t.projectPath === projectPath || !t.projectPath,
		);
		const projectTasks = tasks.filter((t) => t.projectId === projectId);
		syncAll(projectTerminals, projectTasks);
	}, [terminals, tasks, projectPath, projectId, syncAll]);

	// ── Sync swarm subtasks → pixel agents ──────────────────────

	// The store has been able to draw swarm subtasks as their own characters
	// since it was written; nothing ever called it, so a parallel run showed one
	// character for the parent task while a dozen agents worked underneath it.
	// Upstream (pixel-agents) treats sub-agents as first-class office workers for
	// exactly this reason: the room is meant to show you what is actually running.
	useEffect(() => {
		if (swarmNodes && Object.keys(swarmNodes).length > 0) {
			syncSwarmAgents(swarmNodes);
		} else {
			clearSwarmAgents();
		}
	}, [swarmNodes, syncSwarmAgents, clearSwarmAgents]);

	// ── Sound notifications ─────────────────────────────────────

	const soundEnabled = settings.soundEnabled;
	useEffect(() => {
		if (!soundEnabled) return;
		const unsubscribe = onOfficeSignal((signal) => playChime(signal));
		return () => {
			unsubscribe();
			closeChimes();
		};
	}, [soundEnabled]);

	// ── Achievements, TV mode, calm ─────────────────────────────

	const achievements = useOfficeAchievements({
		projectId,
		projectPath,
		tasks,
		ready: !tasksLoading,
	});
	const refreshAchievements = achievements.refresh;
	const kioskRefresh = useCallback(() => {
		void loadTasks(projectId);
		refreshAchievements();
	}, [projectId, refreshAchievements]);
	const kiosk = useKioskMode(containerRef, kioskRefresh);
	const season = useOfficeSeason(
		achievements.projectTasks,
		achievements.incidents,
		achievements.now,
	);
	const scenes = useOfficeNarratives({
		projectId,
		tasks: achievements.projectTasks,
		ready: !tasksLoading,
		enabled: settings.narratives,
		ai: settings.narrativesAi,
		language: i18n.language,
	});
	const calm = useOfficeCalm(settings.calmMode);
	const toggleCalm = useCallback(
		() =>
			updateSettings({
				calmMode: !usePixelOfficeStore.getState().settings.calmMode,
			}),
		[updateSettings],
	);

	// ── Canvas area resize ──────────────────────────────────────

	// The canvas area itself is measured, not the whole view minus a toolbar
	// height: TV mode's header is taller than the toolbar it replaces. A ref
	// callback with a cleanup (React 19) observes the element it is given,
	// instead of an effect reading a ref that may not be attached yet.
	const observeArea = useCallback((el: HTMLDivElement) => {
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				setDimensions({
					width: Math.max(0, Math.floor(width)),
					height: Math.max(0, Math.floor(height)),
				});
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// ── Bubble handlers ─────────────────────────────────────────

	const handleAgentClick = useCallback(
		(agentId: string, screenX: number, screenY: number) => {
			if (!agentId) {
				selectAgent(null);
				setBubblePos(null);
				return;
			}
			selectAgent(agentId);
			setBubblePos({ x: screenX, y: screenY });
		},
		[selectAgent],
	);

	const closeBubble = useCallback(() => {
		selectAgent(null);
		setBubblePos(null);
	}, [selectAgent]);

	// ── Terminal agent actions ───────────────────────────────────
	// The bubble only exists for a selected agent, and only a terminal's panel
	// offers these, so each receives that terminal's id.

	const handleGoToTerminal = (terminalId: string) => {
		jumpToTerminal(terminalId);
		onNavigateToTerminals?.();
		closeBubble();
	};

	const handleKill = async (terminalId: string) => {
		closeBubble();
		await globalThis.electronAPI.destroyTerminal(terminalId);
		removeTerminal(terminalId);
	};

	// ── Task agent actions ───────────────────────────────────────

	const handleGoToTask = (taskId: string) => {
		selectTask(taskId);
		jumpToTask(taskId); // triggers scroll + spotlight in TaskCard
		onNavigateToKanban?.();
		closeBubble();
	};

	const handleStopTask = (taskId: string) => {
		globalThis.electronAPI.stopTask(taskId);
		closeBubble();
	};

	// ── Pending agent click (from WaitingQueue strip) ────────────

	const handlePendingAgentClick = useCallback(
		(agentId: string, x: number) => {
			selectAgent(agentId);
			setBubblePos({ x, y: 0 }); // bubble fills from top so it appears above the queue
		},
		[selectAgent],
	);

	// ── New terminal ─────────────────────────────────────────────

	const handleAddAgent = useCallback(async () => {
		// Reuse a sibling terminal's directory when there is one, otherwise the
		// project root. The previous fallback was the user's home directory, which
		// is where a terminal opened from a project view is least useful.
		const cwd =
			terminals.find((t) => t.projectPath === projectPath)?.cwd || projectPath;
		const newTerminal = addTerminal(cwd, projectPath);
		if (!newTerminal) return;
		await globalThis.electronAPI.createTerminal({
			id: newTerminal.id,
			cwd: newTerminal.cwd,
			projectPath: projectPath,
		});
	}, [terminals, projectPath, addTerminal]);

	// ── Zoom / grid / sound ──────────────────────────────────────

	const handleZoomIn = useCallback(
		() =>
			updateSettings({
				zoom: Math.min(usePixelOfficeStore.getState().settings.zoom + 1, MAX_ZOOM),
			}),
		[updateSettings],
	);
	const handleZoomOut = useCallback(
		() =>
			updateSettings({
				zoom: Math.max(usePixelOfficeStore.getState().settings.zoom - 1, MIN_ZOOM),
			}),
		[updateSettings],
	);
	const toggleSound = useCallback(
		() =>
			updateSettings({
				soundEnabled: !usePixelOfficeStore.getState().settings.soundEnabled,
			}),
		[updateSettings],
	);
	const toggleGrid = useCallback(
		() =>
			updateSettings({
				showGrid: !usePixelOfficeStore.getState().settings.showGrid,
			}),
		[updateSettings],
	);

	// ── Keyboard shortcuts ───────────────────────────────────────

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			// Never steal a keystroke aimed at the bubble's command input.
			const target = e.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement
			) {
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			switch (e.key) {
				case "+":
				case "=":
					handleZoomIn();
					break;
				case "-":
					handleZoomOut();
					break;
				case "g":
				case "G":
					toggleGrid();
					break;
				case "m":
				case "M":
					toggleSound();
					break;
				case "ArrowRight":
				case "ArrowLeft": {
					const id = cycleSelection(e.key === "ArrowRight" ? 1 : -1);
					// The canvas anchors the bubble to the clicked point; keyboard
					// selection has no click, so it opens centred below the toolbar.
					if (id) setBubblePos({ x: dimensions.width / 2, y: 0 });
					break;
				}
				default:
					return;
			}
			e.preventDefault();
		};

		globalThis.addEventListener("keydown", handler);
		return () => globalThis.removeEventListener("keydown", handler);
	}, [
		handleZoomIn,
		handleZoomOut,
		toggleGrid,
		toggleSound,
		cycleSelection,
		dimensions.width,
	]);

	// ── Derived state ────────────────────────────────────────────

	const selectedAgent = agents.find((a) => a.id === selectedAgentId);
	const selectedTerminal =
		selectedAgent?.type === "terminal"
			? terminals.find((t) => t.id === selectedAgentId)
			: undefined;

	const earnedCount = Object.keys(achievements.unlocked).length;
	const shippedTodayCount = useMemo(
		() =>
			shippedToday(
				tasks.filter((t) => t.projectId === projectId),
				new Date(),
			),
		[tasks, projectId],
	);

	const { pendingAgents, seatedAgents, counts } = useMemo(() => {
		const pending = agents.filter((a) => a.activity === "pending");
		const seated = agents.filter((a) => a.activity !== "pending");
		return {
			pendingAgents: pending,
			seatedAgents: seated,
			counts: {
				terminals: seated.filter((a) => a.type === "terminal").length,
				tasks: seated.filter((a) => a.type === "task").length,
				swarm: seated.filter((a) => a.type === "swarm").length,
				active: seated.filter(
					(a) => a.activity !== "idle" && a.activity !== "exited",
				).length,
				waiting: seated.filter((a) => a.activity === "waiting").length,
			},
		};
	}, [agents]);

	return (
		<div ref={containerRef} className="wp-scope flex flex-col h-full overflow-hidden">
			{kiosk.active && (
				<KioskOverlay
					stats={{
						active: counts.active,
						waiting: counts.waiting,
						shippedToday: shippedTodayCount,
						achievements: earnedCount,
					}}
					calm={calm}
					calmLocked={calm && !settings.calmMode}
					onToggleCalm={toggleCalm}
					onExit={kiosk.exit}
				/>
			)}
			{/* Toolbar */}
			<div
				className={`flex items-center justify-between gap-3 px-5 py-2.5 border-b border-dashed border-[var(--wp-border)] bg-background/80 backdrop-blur-sm shrink-0${kiosk.active ? " hidden" : ""}`}
			>
				<div className="flex min-w-0 items-center gap-3">
					<span className="wp-empty-glyph h-8 w-8 shrink-0" aria-hidden="true">
						<Building2 className="h-4 w-4" />
					</span>
					<span className="wp-header-text mr-2">
						<span className="wp-kicker">{t("navigation:groups.agents")}</span>
						<span className="wp-title">{t("pixelOffice:title")}</span>
					</span>
					<Chips>
						{counts.terminals > 0 && (
							<Chip tone="blue">{t("pixelOffice:badges.terminals", { count: counts.terminals })}</Chip>
						)}
						{counts.tasks > 0 && <Chip tone="orange">{t("pixelOffice:badges.tasks", { count: counts.tasks })}</Chip>}
						{counts.swarm > 0 && <Chip tone="violet">{t("pixelOffice:badges.swarm", { count: counts.swarm })}</Chip>}
						{counts.active > 0 && <Chip tone="green">{t("pixelOffice:badges.active", { count: counts.active })}</Chip>}
						{pendingAgents.length > 0 && (
							<Chip tone="pink">{t("pixelOffice:badges.pending", { count: pendingAgents.length })}</Chip>
						)}
					</Chips>
					<ProviderLegend agents={seatedAgents} />
				</div>

				<div className="flex items-center gap-1">
					<AddAgentButton
						onClick={handleAddAgent}
						disabled={!canAddTerminal(projectPath)}
					/>
					<div className="w-px h-5 bg-border mx-1" />
					<AchievementsPanel unlocked={achievements.unlocked} />
					<SeasonPanel
						season={season.season}
						progress={season.progress}
						decor={season.decor}
					/>
					<OfficeScenesMenu
						enabled={settings.narratives}
						ai={settings.narrativesAi}
						onChange={updateSettings}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={kiosk.enter}
								aria-label={t("pixelOffice:kiosk.enter")}
							>
								<Tv className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("pixelOffice:kiosk.enter")}</TooltipContent>
					</Tooltip>
					<div className="w-px h-5 bg-border mx-1" />

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={handleZoomOut}
								disabled={settings.zoom <= MIN_ZOOM}
								aria-label={t("pixelOffice:toolbar.zoomOut")}
							>
								<ZoomOut className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("pixelOffice:toolbar.zoomOut")}</TooltipContent>
					</Tooltip>

					<span className="text-xs font-mono text-muted-foreground w-8 text-center">
						{settings.zoom}x
					</span>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={handleZoomIn}
								disabled={settings.zoom >= MAX_ZOOM}
								aria-label={t("pixelOffice:toolbar.zoomIn")}
							>
								<ZoomIn className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("pixelOffice:toolbar.zoomIn")}</TooltipContent>
					</Tooltip>

					<div className="w-px h-5 bg-border mx-1" />

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={toggleGrid}
								aria-pressed={settings.showGrid}
								aria-label={t("pixelOffice:toolbar.toggleGrid")}
							>
								<Grid3X3 className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("pixelOffice:toolbar.toggleGrid")}
						</TooltipContent>
					</Tooltip>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={toggleSound}
								aria-pressed={settings.soundEnabled}
								aria-label={t(
									settings.soundEnabled
										? "pixelOffice:toolbar.soundOn"
										: "pixelOffice:toolbar.soundOff",
								)}
							>
								{settings.soundEnabled ? (
									<Volume2 className="h-4 w-4" />
								) : (
									<VolumeX className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t(
								settings.soundEnabled
									? "pixelOffice:toolbar.soundOn"
									: "pixelOffice:toolbar.soundOff",
							)}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>


			{/* Canvas area */}
			<div
				ref={observeArea}
				className="flex-1 bg-[#1A1A2E] overflow-hidden relative"
				title={t("pixelOffice:toolbar.shortcuts")}
			>
				<AchievementToast
					achievement={achievements.toast}
					onDismiss={achievements.dismissToast}
					calm={calm}
				/>
				<NarrativeFeed scenes={scenes} calm={calm} />
				{agents.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-center gap-4 px-8">
						<Building2 className="h-16 w-16 text-white/25" aria-hidden />
						<h2 className="text-xl font-bold text-white/80 font-mono">
							{t("pixelOffice:emptyState.title")}
						</h2>
						<p className="text-sm text-white/50 max-w-md">
							{t("pixelOffice:emptyState.description")}
						</p>
						<AddAgentButton
							onClick={handleAddAgent}
							disabled={!canAddTerminal(projectPath)}
						/>
					</div>
				) : (
					<>
						{seatedAgents.length > 0 && (
							<PixelOfficeCanvas
								width={dimensions.width}
								height={dimensions.height}
								emptyDeskLabel={t("pixelOffice:canvas.emptyDesk")}
								calm={calm}
								decor={season.decorIds}
								onAgentClick={handleAgentClick}
							/>
						)}

						{/* Pending-only placeholder when no desk agents yet */}
						{seatedAgents.length === 0 && (
							<div className="flex flex-col items-center justify-center h-full pb-40 gap-3 text-center px-8">
								<Building2 className="h-12 w-12 text-white/20" aria-hidden />
								<p className="text-sm text-white/40 font-mono">
									{t("pixelOffice:pendingOnly")}
								</p>
							</div>
						)}

						{/* Waiting queue strip — always visible when pending agents exist */}
						<WaitingQueue
							agents={pendingAgents}
							onAgentClick={handlePendingAgentClick}
							calm={calm}
						/>

						{/* Backdrop */}
						{selectedAgent && bubblePos && (
							<button
								type="button"
								aria-label={t("pixelOffice:bubble.close")}
								className="absolute inset-0 cursor-default bg-transparent border-0 p-0"
								style={{ zIndex: 40 }}
								onClick={closeBubble}
							/>
						)}

						{/* Speech bubble overlay */}
						{selectedAgent && bubblePos && (
							<AgentBubble
								agent={selectedAgent}
								terminal={selectedTerminal}
								anchorX={bubblePos.x}
								anchorY={bubblePos.y}
								onClose={closeBubble}
								onGoToTerminal={() => handleGoToTerminal(selectedAgent.id)}
								onGoToTask={handleGoToTask}
								onKill={() => handleKill(selectedAgent.id)}
								onInterrupt={() =>
									globalThis.electronAPI.sendTerminalInput(
										selectedAgent.id,
										"\x03",
									)
								}
								onResumeClaude={() =>
									globalThis.electronAPI.invokeClaudeInTerminal(selectedAgent.id)
								}
								onSendCommand={(cmd) =>
									globalThis.electronAPI.sendTerminalInput(
										selectedAgent.id,
										`${cmd}\n`,
									)
								}
								onStopTask={handleStopTask}
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
}
