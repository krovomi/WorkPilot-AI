/**
 * Pixel Office Canvas — The core rendering engine.
 *
 * Renders a pixel art office with animated characters representing
 * active agent terminals, Kanban tasks and swarm subtasks.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type AgentActivity,
	type PixelAgent,
	usePixelOfficeStore,
} from "../../stores/pixel-office-store";
import {
	CHAR_OFFSET_Y,
	computeOfficeLayout,
	computeViewport,
	DESK_W,
	type OfficeLayout,
	SEAT_HIT_H,
	seatPosition,
	toOfficePoint,
} from "./office-layout";
import {
	type ActivityIcon,
	CHAIR_H,
	DESK_H,
	drawSpeechBubble,
	getActivityIcon,
	getChairSprite,
	getCharacterSprite,
	getDeskSprite,
	getFloorTile,
	getWallTile,
	SPRITE_H,
	TILE_SIZE,
} from "./pixel-sprites";

// ── Activity config ───────────────────────────────────────────

const ACTIVITY_COLORS: Record<string, string> = {
	typing: "#4A90D9",
	running: "#1ABC9C",
	waiting: "#F39C12",
	reading: "#27AE60",
	exited: "#E74C3C",
	idle: "#6B7280",
};

/** Frames per second. The characters animate on a 2-frame cycle; 30 is plenty. */
const TARGET_FPS = 30;

/** Opacity of an agent whose session has ended — upstream calls these ghosts. */
const GHOST_ALPHA = 0.32;
/** Opacity of an agent that is seated but doing nothing. */
const IDLE_ALPHA = 0.55;

interface AgentVisual {
	color: string;
	isActive: boolean;
	isWaiting: boolean;
	isIdle: boolean;
	isGhost: boolean;
	bounceY: number;
}

function getAgentVisual(
	activity: AgentActivity,
	frame: number,
	z: number,
): AgentVisual {
	const color = ACTIVITY_COLORS[activity] ?? "#6B7280";
	const isActive =
		activity === "typing" || activity === "running" || activity === "reading";
	const isWaiting = activity === "waiting";
	const isGhost = activity === "exited";
	const isIdle = activity === "idle" || isGhost;

	let bounceY = 0;
	if (activity === "typing") bounceY = Math.sin(frame * 0.35) * 1.2 * z;
	else if (activity === "running")
		bounceY = Math.abs(Math.sin(frame * 0.25)) * -1.5 * z;
	else if (isWaiting) bounceY = Math.sin(frame * 0.08) * 0.8 * z;

	return { color, isActive, isWaiting, isIdle, isGhost, bounceY };
}

function activityToDirection(activity: AgentActivity): "down" | "up" {
	if (activity === "typing" || activity === "reading" || activity === "running")
		return "up";
	return "down";
}

function activityToIcon(activity: AgentActivity): ActivityIcon {
	switch (activity) {
		case "typing":
			return "typing";
		case "reading":
			return "reading";
		case "running":
			return "running";
		case "waiting":
			return "waiting";
		default:
			return "idle";
	}
}

// ── Per-agent drawing helpers ─────────────────────────────────

function drawActivityGlow(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	color: string,
	isWaiting: boolean,
	z: number,
	frame: number,
) {
	const pulse = isWaiting
		? 0.18 + Math.sin(frame * 0.07) * 0.1
		: 0.22 + Math.sin(frame * 0.18) * 0.08;
	ctx.save();
	ctx.globalAlpha = pulse;
	const grad = ctx.createRadialGradient(
		cx + 8 * z,
		cy + 20 * z,
		0,
		cx + 8 * z,
		cy + 20 * z,
		16 * z,
	);
	grad.addColorStop(0, color);
	grad.addColorStop(1, "transparent");
	ctx.fillStyle = grad;
	ctx.beginPath();
	ctx.ellipse(cx + 8 * z, cy + 22 * z, 14 * z, 6 * z, 0, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}

function drawMonitorGlow(
	ctx: CanvasRenderingContext2D,
	dx: number,
	dy: number,
	color: string,
	z: number,
	frame: number,
) {
	ctx.save();
	ctx.globalAlpha = 0.25 + Math.sin(frame * 0.22) * 0.12;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(dx + 10 * z, dy, 12 * z, 5 * z, 2);
	ctx.fill();
	ctx.restore();
}

/**
 * Progress gauge under the character.
 *
 * Upstream shows a per-agent gauge so you can read the room without opening
 * anything; here the number already exists on task and swarm agents — it was
 * only ever visible after clicking one open.
 */
function drawProgressGauge(
	ctx: CanvasRenderingContext2D,
	dx: number,
	y: number,
	progress: number,
	color: string,
	z: number,
) {
	const w = DESK_W * z;
	const h = Math.max(2, 2.5 * z);
	const clamped = Math.max(0, Math.min(100, progress));

	ctx.save();
	ctx.fillStyle = "rgba(0,0,0,0.45)";
	ctx.beginPath();
	ctx.roundRect(dx, y, w, h, h / 2);
	ctx.fill();

	if (clamped > 0) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(dx, y, Math.max(h, (w * clamped) / 100), h, h / 2);
		ctx.fill();
	}
	ctx.restore();
}

interface LabelOpts {
	ctx: CanvasRenderingContext2D;
	agent: PixelAgent;
	cx: number;
	top: number;
	color: string;
	isIdle: boolean;
	isSelected: boolean;
	z: number;
}

/** Wrap text by measuring real pixel widths with ctx.measureText. */
function measureWrap(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxW: number,
): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (ctx.measureText(candidate).width <= maxW) {
			current = candidate;
		} else {
			if (current) lines.push(current);
			// If a single word is wider than maxW, hard-truncate it
			current =
				ctx.measureText(word).width <= maxW
					? word
					: word.slice(
							0,
							Math.max(
								3,
								Math.floor((word.length * maxW) / ctx.measureText(word).width),
							),
						);
		}
	}
	if (current) lines.push(current);
	return lines;
}

function drawAgentLabel({
	ctx,
	agent,
	cx,
	top,
	color,
	isIdle,
	isSelected,
	z,
}: LabelOpts) {
	let labelColor: string;
	if (isSelected) labelColor = "#FFD700";
	else if (isIdle) labelColor = "#808080";
	else labelColor = color;

	const name = agent.fullName; // full untruncated name
	const fontSize = Math.max(4, 6 * z);
	ctx.fillStyle = labelColor;
	ctx.font = `bold ${fontSize}px Arial, sans-serif`;
	ctx.textAlign = "center";

	const lineH = fontSize + 2;
	const maxW = 36 * z; // slightly wider than desk (32px) for readability

	const lines = measureWrap(ctx, name, maxW).slice(0, 3);
	for (let i = 0; i < lines.length; i++) {
		ctx.fillText(lines[i], cx, top + i * lineH);
	}

	ctx.textAlign = "start";
}

interface DrawAgentOpts {
	ctx: CanvasRenderingContext2D;
	agent: PixelAgent;
	dx: number;
	dy: number;
	z: number;
	selected: string | null;
	animFrame: number;
	frame: number;
}

function drawAgent({
	ctx,
	agent,
	dx,
	dy,
	z,
	selected,
	animFrame,
	frame,
}: DrawAgentOpts) {
	const visual = getAgentVisual(agent.activity, frame, z);
	const { color, isActive, isWaiting, isIdle, isGhost, bounceY } = visual;

	const cx = dx + 8 * z;
	const cy = dy + CHAR_OFFSET_Y * TILE_SIZE * z + bounceY;
	const isSelected = agent.id === selected;

	if (isGhost) ctx.globalAlpha = GHOST_ALPHA;
	else if (isIdle) ctx.globalAlpha = IDLE_ALPHA;

	if (isActive || isWaiting)
		drawActivityGlow(ctx, cx, cy, color, isWaiting, z, frame);
	if (isActive) drawMonitorGlow(ctx, dx, dy, color, z, frame);

	const sprite = getCharacterSprite(
		agent.characterIndex,
		activityToDirection(agent.activity),
		animFrame,
	);

	// Selection ring
	if (isSelected) {
		ctx.save();
		ctx.globalAlpha = 1;
		ctx.strokeStyle = "#FFD700";
		ctx.lineWidth = 2;
		ctx.setLineDash([4, 2]);
		ctx.strokeRect(
			cx - 2 * z,
			cy - 2 * z,
			(sprite.width + 4) * z,
			(sprite.height + 4) * z,
		);
		ctx.setLineDash([]);
		ctx.restore();
	}

	// Character sprite
	ctx.drawImage(sprite, cx, cy, sprite.width * z, sprite.height * z);
	ctx.globalAlpha = 1;

	// Claude mode orange aura — never on a ghost: a closed session is not working.
	if (agent.isClaudeMode && !isGhost) {
		ctx.save();
		ctx.globalAlpha = 0.15 + Math.sin(frame * 0.1) * 0.1;
		ctx.fillStyle = "#D97706";
		ctx.beginPath();
		ctx.arc(cx + 8 * z, cy + 12 * z, 14 * z, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	// Activity icon above head
	if (!isIdle) {
		const icon = getActivityIcon(activityToIcon(agent.activity), animFrame);
		ctx.drawImage(icon, cx + 2 * z, cy - 14 * z, 12 * z, 12 * z);
	}

	// Gauge, then the name below whatever was drawn.
	const gaugeY = cy + (SPRITE_H + 2) * z;
	const hasGauge = typeof agent.progress === "number" && !isGhost;
	if (hasGauge && agent.progress !== undefined) {
		drawProgressGauge(ctx, dx, gaugeY, agent.progress, color, z);
	}

	drawAgentLabel({
		ctx,
		agent,
		cx: dx + (DESK_W / 2) * z,
		top: cy + (SPRITE_H + (hasGauge ? 9 : 4)) * z,
		color,
		isIdle,
		isSelected,
		z,
	});

	if (agent.speechBubble)
		drawSpeechBubble(ctx, cx + 8 * z, cy - 16 * z, agent.speechBubble, z);
}

// ── Background drawing helpers ────────────────────────────────

function drawFloor(
	ctx: CanvasRenderingContext2D,
	layout: OfficeLayout,
	z: number,
) {
	const tile = getFloorTile();
	for (let row = 0; row < layout.rows; row++) {
		for (let col = 0; col < layout.cols; col++) {
			ctx.drawImage(
				tile,
				col * TILE_SIZE * z,
				row * TILE_SIZE * z,
				TILE_SIZE * z,
				TILE_SIZE * z,
			);
		}
	}
}

function drawWalls(
	ctx: CanvasRenderingContext2D,
	layout: OfficeLayout,
	z: number,
) {
	const tile = getWallTile();
	for (let col = 0; col < layout.cols; col++) {
		ctx.drawImage(tile, col * TILE_SIZE * z, 0, TILE_SIZE * z, TILE_SIZE * z);
	}
	for (let row = 0; row < layout.rows; row++) {
		ctx.drawImage(tile, 0, row * TILE_SIZE * z, TILE_SIZE * z, TILE_SIZE * z);
	}
}

/**
 * Tile grid overlay. `showGrid` has been in the settings — and on the toolbar —
 * since the feature shipped, toggling a value nothing drew.
 */
function drawGrid(
	ctx: CanvasRenderingContext2D,
	layout: OfficeLayout,
	z: number,
) {
	const step = TILE_SIZE * z;
	ctx.save();
	ctx.strokeStyle = "rgba(255,255,255,0.07)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let col = 0; col <= layout.cols; col++) {
		ctx.moveTo(col * step, 0);
		ctx.lineTo(col * step, layout.rows * step);
	}
	for (let row = 0; row <= layout.rows; row++) {
		ctx.moveTo(0, row * step);
		ctx.lineTo(layout.cols * step, row * step);
	}
	ctx.stroke();
	ctx.restore();
}

function drawDecorations(
	ctx: CanvasRenderingContext2D,
	layout: OfficeLayout,
	z: number,
) {
	// Water cooler
	const wcX = (layout.cols - 2) * TILE_SIZE * z;
	const wcY = (layout.rows - 2) * TILE_SIZE * z;
	ctx.fillStyle = "#4A90D9";
	ctx.fillRect(wcX, wcY, 8 * z, 12 * z);
	ctx.fillStyle = "#87CEEB";
	ctx.fillRect(wcX + z, wcY + z, 6 * z, 4 * z);

	// Plant
	const plX = 1 * TILE_SIZE * z;
	const plY = (layout.rows - 1) * TILE_SIZE * z;
	ctx.fillStyle = "#27AE60";
	ctx.fillRect(plX + 2 * z, plY - 4 * z, 4 * z, 4 * z);
	ctx.fillRect(plX + z, plY - 6 * z, 6 * z, 2 * z);
	ctx.fillStyle = "#8B4513";
	ctx.fillRect(plX + 2 * z, plY, 4 * z, 4 * z);
}

// ── Component ────────────────────────────────────────────────

interface PixelOfficeCanvasProps {
	readonly width: number;
	readonly height: number;
	/** Translated caption drawn on a desk nobody sits at. */
	readonly emptyDeskLabel: string;
	readonly onAgentClick?: (
		agentId: string,
		screenX: number,
		screenY: number,
	) => void;
}

export function PixelOfficeCanvas({
	width,
	height,
	emptyDeskLabel,
	onAgentClick,
}: PixelOfficeCanvasProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef(0);
	const animFrameRef = useRef<number>(0);
	const lastTimeRef = useRef(0);

	const agents = usePixelOfficeStore((s) => s.agents);
	const selectedAgentId = usePixelOfficeStore((s) => s.selectedAgentId);
	const zoom = usePixelOfficeStore((s) => s.settings.zoom);
	const showGrid = usePixelOfficeStore((s) => s.settings.showGrid);

	const seatedAgents = useMemo(
		() => agents.filter((a) => a.seatIndex >= 0),
		[agents],
	);

	const layout = useMemo(
		() => computeOfficeLayout(seatedAgents.length, width, zoom),
		[seatedAgents.length, width, zoom],
	);

	// The render loop reads these through refs so it never has to be rebuilt —
	// tearing down and restarting requestAnimationFrame on every store update is
	// what makes a canvas stutter.
	const seatedRef = useRef(seatedAgents);
	seatedRef.current = seatedAgents;
	const selectedRef = useRef(selectedAgentId);
	selectedRef.current = selectedAgentId;
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	const showGridRef = useRef(showGrid);
	showGridRef.current = showGrid;
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const sizeRef = useRef({ width, height });
	sizeRef.current = { width, height };
	const emptyLabelRef = useRef(emptyDeskLabel);
	emptyLabelRef.current = emptyDeskLabel;

	// ── Render loop ────────────────────────────────────────

	const render = useCallback((timestamp: number) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		animFrameRef.current = requestAnimationFrame(render);

		// A hidden view animates nothing anyone can see. requestAnimationFrame is
		// already throttled in a background window, but the office is just as
		// invisible behind another view in the same window, where it is not.
		if (document.hidden) return;

		const delta = timestamp - lastTimeRef.current;
		if (delta < 1000 / TARGET_FPS) return;
		lastTimeRef.current = timestamp;
		frameRef.current++;

		const z = zoomRef.current;
		const agents = seatedRef.current;
		const selected = selectedRef.current;
		const frame = frameRef.current;
		const layout = layoutRef.current;
		const { width: cssW, height: cssH } = sizeRef.current;

		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, cssW, cssH);

		const viewport = computeViewport(layout, z, cssW, cssH);

		ctx.save();
		ctx.translate(viewport.offsetX, viewport.offsetY);
		ctx.scale(viewport.scale, viewport.scale);

		drawFloor(ctx, layout, z);
		drawWalls(ctx, layout, z);
		if (showGridRef.current) drawGrid(ctx, layout, z);

		const deskSprite = getDeskSprite();
		const chairSprite = getChairSprite();
		const animFrame = Math.floor(frame / 15) % 2;
		const bySeat = new Map(agents.map((a) => [a.seatIndex, a]));

		for (let seat = 0; seat < layout.seatCount; seat++) {
			const pos = seatPosition(layout, seat);
			const dx = pos.x * TILE_SIZE * z;
			const dy = pos.y * TILE_SIZE * z;

			ctx.drawImage(deskSprite, dx, dy, DESK_W * z, DESK_H * z);
			ctx.drawImage(chairSprite, dx, dy + DESK_H * z, DESK_W * z, CHAIR_H * z);

			const occupant = bySeat.get(seat);
			if (!occupant) {
				ctx.fillStyle = "rgba(255,255,255,0.15)";
				ctx.font = `${Math.max(7, 8 * z)}px "Courier New", monospace`;
				ctx.textAlign = "center";
				ctx.fillText(
					emptyLabelRef.current,
					dx + (DESK_W / 2) * z,
					dy + (DESK_H + 14) * z,
				);
				ctx.textAlign = "start";
				continue;
			}

			drawAgent({ ctx, agent: occupant, dx, dy, z, selected, animFrame, frame });
		}

		drawDecorations(ctx, layout, z);
		ctx.restore();
	}, []);

	useEffect(() => {
		animFrameRef.current = requestAnimationFrame(render);
		return () => {
			cancelAnimationFrame(animFrameRef.current);
		};
	}, [render]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(width * dpr));
		canvas.height = Math.max(1, Math.round(height * dpr));
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		// Setting width/height resets the transform, so this scale is applied to a
		// clean context. Everything drawn afterwards is in CSS pixels.
		canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
	}, [width, height]);

	// ── Click handling ─────────────────────────────────────

	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (!canvas) return;

			const rect = canvas.getBoundingClientRect();
			const z = zoomRef.current;
			const layout = layoutRef.current;
			const viewport = computeViewport(layout, z, rect.width, rect.height);
			const point = toOfficePoint(
				viewport,
				e.clientX - rect.left,
				e.clientY - rect.top,
			);

			for (const agent of seatedRef.current) {
				const pos = seatPosition(layout, agent.seatIndex);
				const deskX = pos.x * TILE_SIZE * z;
				const deskY = pos.y * TILE_SIZE * z;

				if (
					point.x >= deskX &&
					point.x <= deskX + DESK_W * z &&
					point.y >= deskY &&
					point.y <= deskY + SEAT_HIT_H * z
				) {
					const charY = deskY + CHAR_OFFSET_Y * TILE_SIZE * z;
					onAgentClick?.(
						agent.id,
						e.clientX - rect.left,
						charY * viewport.scale + viewport.offsetY,
					);
					return;
				}
			}
			onAgentClick?.("", 0, 0);
		},
		[onAgentClick],
	);

	return (
		<canvas
			ref={canvasRef}
			onClick={handleClick}
			className="cursor-pointer"
			style={{
				imageRendering: "pixelated",
				width: `${width}px`,
				height: `${height}px`,
			}}
		/>
	);
}
