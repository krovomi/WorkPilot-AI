/**
 * custom-bricks — the blocks a person makes for themselves.
 *
 * The palette's catalogue (`architecture-blocks.ts`) names what most
 * architectures are made of, and nothing more: an "AI agent", a "billing
 * engine" or a "legacy mainframe" had to be drawn as the grey `custom` block
 * and renamed every time. A brick is that block given a name, a role written
 * above it, a colour, an icon and a sentence saying what it does — saved once,
 * reused from the palette in every architecture.
 *
 * A node made from a brick carries a copy of the brick's look in its own data,
 * so a diagram stays readable when exported, shared or after the brick is
 * deleted. While the brick exists, `applyBricks` refreshes that copy, so
 * editing a brick restyles every block made from it.
 *
 * Pure apart from the icon components, so it is unit testable.
 */

import {
	Blocks,
	Bot,
	Boxes,
	Brain,
	Cloud,
	Cpu,
	Database,
	FileText,
	GitBranch,
	Globe,
	KeyRound,
	Layers,
	type LucideIcon,
	Mail,
	Plug,
	Server,
	ShieldCheck,
	Smartphone,
	Sparkles,
	Terminal,
	Users,
	Workflow,
	Zap,
} from "lucide-react";
import { blockMeta } from "./architecture-blocks";

/** Icons a brick can wear. The key is what is stored, never the component. */
export const BRICK_ICONS: Record<string, LucideIcon> = {
	blocks: Blocks,
	bot: Bot,
	brain: Brain,
	sparkles: Sparkles,
	workflow: Workflow,
	zap: Zap,
	cpu: Cpu,
	server: Server,
	database: Database,
	layers: Layers,
	boxes: Boxes,
	cloud: Cloud,
	globe: Globe,
	smartphone: Smartphone,
	plug: Plug,
	terminal: Terminal,
	gitBranch: GitBranch,
	fileText: FileText,
	mail: Mail,
	users: Users,
	shield: ShieldCheck,
	key: KeyRound,
};

/** Swatches offered by the brick editor; any `#rrggbb` is accepted too. */
export const BRICK_ACCENTS = [
	"#f97316",
	"#f59e0b",
	"#eab308",
	"#84cc16",
	"#10b981",
	"#14b8a6",
	"#06b6d4",
	"#3b82f6",
	"#6366f1",
	"#8b5cf6",
	"#d946ef",
	"#f43f5e",
	"#64748b",
];

export const DEFAULT_BRICK_ACCENT = "#f97316";
export const DEFAULT_BRICK_ICON = "blocks";

/** Dragged from the palette as `application/block-type`: `brick:<id>`. */
export const BRICK_DRAG_PREFIX = "brick:";

export const BRICK_LIMITS = {
	name: 60,
	kicker: 32,
	description: 400,
	stack: 40,
} as const;

export interface CustomBrick {
	id: string;
	/** The name a new block made from it starts with. */
	name: string;
	/** The small uppercase role written above the name ("AGENT PRINCIPAL"). */
	kicker: string;
	accent: string;
	icon: string;
	/** What it does. Goes into the build spec next to the component. */
	description: string;
	/** Technology a new block starts with, if any. */
	stack: string;
}

export type BrickInput = Omit<CustomBrick, "id">;

/** The visual fields a node carries for itself (copied from its brick, or set in the inspector). */
export interface NodeLook {
	label?: string;
	type?: string;
	framework?: string;
	kicker?: string;
	accent?: string;
	icon?: string;
	description?: string;
	brickId?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isAccent(value: unknown): value is string {
	return typeof value === "string" && HEX.test(value);
}

function clip(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A brick as it may be stored: trimmed, bounded, with a known icon and a real
 * colour. Persisted data and a hand-edited export both come through here, so
 * nothing downstream has to defend against a missing field. `null` when there
 * is no name — a brick without one cannot be placed or found in the palette.
 */
export function normalizeBrick(input: Partial<BrickInput>): BrickInput | null {
	const name = clip(input.name, BRICK_LIMITS.name);
	if (!name) return null;
	return {
		name,
		kicker: clip(input.kicker, BRICK_LIMITS.kicker),
		accent: isAccent(input.accent) ? input.accent : DEFAULT_BRICK_ACCENT,
		icon:
			typeof input.icon === "string" && input.icon in BRICK_ICONS
				? input.icon
				: DEFAULT_BRICK_ICON,
		description: clip(input.description, BRICK_LIMITS.description),
		stack: clip(input.stack, BRICK_LIMITS.stack),
	};
}

/** The look a brick lends to the nodes made from it. */
function brickLook(brick: CustomBrick): NodeLook {
	return {
		type: "custom",
		brickId: brick.id,
		kicker: brick.kicker || undefined,
		accent: brick.accent,
		icon: brick.icon,
		description: brick.description || undefined,
	};
}

/** The data of a new node made from a brick. */
export function brickNodeData(brick: CustomBrick): NodeLook {
	return {
		label: brick.name,
		...brickLook(brick),
		...(brick.stack ? { framework: brick.stack } : {}),
	};
}

/**
 * Bring the nodes made from a brick up to date with the brick.
 *
 * Only the brick's look is copied; the node's own name and stack are the
 * person's, per block. A node whose brick is gone keeps its last copy. Returns
 * the same array when nothing changed, so a memo downstream stays put.
 */
export function applyBricks<T extends { data?: NodeLook }>(
	nodes: T[],
	bricks: CustomBrick[],
): T[] {
	if (bricks.length === 0) return nodes;
	const byId = new Map(bricks.map((b) => [b.id, b]));
	let changed = false;
	const next = nodes.map((node) => {
		const brick = node.data?.brickId ? byId.get(node.data.brickId) : undefined;
		if (!brick) return node;
		const look = brickLook(brick);
		const same = (Object.keys(look) as (keyof NodeLook)[]).every(
			(key) => node.data?.[key] === look[key],
		);
		if (same) return node;
		changed = true;
		return { ...node, data: { ...node.data, ...look } };
	});
	return changed ? next : nodes;
}

export interface ResolvedLook {
	accent: string;
	icon: LucideIcon;
	/** Translation key of the role, used when the node has no kicker of its own. */
	kickerKey: string;
	kicker?: string;
}

/**
 * How a node is drawn: its own kicker, colour and icon when it has them (a
 * brick, or a role typed in the inspector), else its palette type's.
 */
export function resolveLook(data: NodeLook | undefined): ResolvedLook {
	const meta = blockMeta(data?.type);
	return {
		accent: isAccent(data?.accent) ? data.accent : (meta?.accent ?? "#64748b"),
		icon:
			(data?.icon ? BRICK_ICONS[data.icon] : undefined) ??
			meta?.icon ??
			Blocks,
		kickerKey: meta?.labelKey ?? "untyped",
		kicker: data?.kicker?.trim() || undefined,
	};
}
