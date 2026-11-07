import { ChevronRight, Pencil, Plus, Search, X } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BLOCK_CATEGORIES,
	type BlockMeta,
	filterBlocks,
} from "../lib/architecture-blocks";
import {
	BRICK_DRAG_PREFIX,
	type CustomBrick,
	resolveLook,
} from "../lib/custom-bricks";
import { useCustomBricksStore } from "../stores/custom-bricks-store";
import { Input } from "./ui/input";
import { BrickEditorDialog } from "./visual-to-code/BrickEditorDialog";
interface PaletteProps {
	compact?: boolean;
	/**
	 * Click-to-add. Dragging is the only way to place a block without this, and
	 * a drag is the one gesture that fails silently — on a trackpad, across a
	 * scrolled palette, or for anyone who cannot hold a button down.
	 */
	onAddBlock?: (type: string) => void;
}

/**
 * Palette of architecture blocks.
 *
 * The catalogue itself lives in `lib/architecture-blocks` so the node renderer
 * shows the same icon and accent as the palette entry it came from. This file
 * is only the list: search, collapsible groups, drag and click.
 */
export const VisualProgrammingPalette: React.FC<PaletteProps> = ({
	compact = false,
	onAddBlock,
}) => {
	const { t } = useTranslation("visualProgramming");
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const bricks = useCustomBricksStore((s) => s.bricks);
	const [editor, setEditor] = useState<{
		open: boolean;
		brick: CustomBrick | null;
	}>({ open: false, brick: null });
	const shownBricks = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return bricks;
		return bricks.filter((b) =>
			[b.name, b.kicker, b.description].some((v) =>
				v.toLowerCase().includes(q),
			),
		);
	}, [bricks, query]);

	const categories = useMemo(
		() => filterBlocks(query, (key) => t(key, key)),
		[query, t],
	);
	const total = useMemo(
		() =>
			categories.reduce((n, c) => n + c.blocks.length, 0) + shownBricks.length,
		[categories, shownBricks],
	);

	const toggle = (key: string) =>
		setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

	const handleDragStart = (e: React.DragEvent, type: string) => {
		e.dataTransfer.setData("application/block-type", type);
		e.dataTransfer.effectAllowed = "copy";
	};

	if (compact) {
		return (
			<div
				className="flex items-center justify-center w-14 h-14 text-2xl"
				title={t("showPalette", "Afficher la palette")}
			>
				<Search className="h-6 w-6 text-muted-foreground" />
			</div>
		);
	}

	const renderBlock = (block: BlockMeta) => {
		const Icon = block.icon;
		return (
			<button
				key={block.type}
				type="button"
				draggable
				onDragStart={(e) => handleDragStart(e, block.type)}
				onClick={() => onAddBlock?.(block.type)}
				title={t(block.descKey, "")}
				className="group flex w-full items-center gap-2.5 rounded-md border border-transparent bg-card/40 px-2 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-accent/60 active:cursor-grabbing cursor-grab"
			>
				<span
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
					style={{
						backgroundColor: `color-mix(in srgb, ${block.accent} 18%, transparent)`,
						color: block.accent,
					}}
				>
					<Icon className="h-3.5 w-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate font-medium text-foreground">
					{t(block.labelKey)}
				</span>
			</button>
		);
	};

	/**
	 * The person's own bricks, above the catalogue: they are what this person
	 * reaches for, and the catalogue is the same for everyone.
	 */
	const renderBrick = (brick: CustomBrick) => {
		const look = resolveLook({ type: "custom", ...brick });
		const Icon = look.icon;
		const type = `${BRICK_DRAG_PREFIX}${brick.id}`;
		return (
			<div key={brick.id} className="group relative">
				<button
					type="button"
					draggable
					onDragStart={(e) => handleDragStart(e, type)}
					onClick={() => onAddBlock?.(type)}
					title={brick.description || brick.name}
					className="flex w-full items-center gap-2.5 rounded-md border border-transparent bg-card/40 px-2 py-1.5 pr-7 text-left text-xs transition-colors hover:border-border hover:bg-accent/60 active:cursor-grabbing cursor-grab"
				>
					<span
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
						style={{
							backgroundColor: `color-mix(in srgb, ${look.accent} 18%, transparent)`,
							color: look.accent,
						}}
					>
						<Icon className="h-3.5 w-3.5" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium text-foreground">
							{brick.name}
						</span>
						{brick.kicker ? (
							<span
								className="block truncate font-mono text-3xs uppercase tracking-wide"
								style={{ color: look.accent }}
							>
								{brick.kicker}
							</span>
						) : null}
					</span>
				</button>
				<button
					type="button"
					onClick={() => setEditor({ open: true, brick })}
					title={t("brickEditTitle", "Modifier la brique")}
					aria-label={t("brickEditTitle", "Modifier la brique")}
					className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
				>
					<Pencil className="h-3 w-3" />
				</button>
			</div>
		);
	};

	const myBricksOpen = query ? true : !collapsed.myBricks;

	return (
		<div className="flex h-full w-full flex-col gap-2 text-foreground">
			<div className="px-1">
				<div className="mb-2 flex items-baseline justify-between">
					<span className="text-sm font-semibold">{t("palette")}</span>
					<span className="text-3xs tabular-nums text-muted-foreground">
						{t("blockCount", "{{count}} blocs", { count: total })}
					</span>
				</div>
				<div className="relative">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("searchBlocks", "Rechercher un bloc…")}
						aria-label={t("searchBlocks", "Rechercher un bloc…")}
						className="w-full py-1.5 pl-7 pr-7 text-xs h-auto"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label={t("clearSearch", "Effacer la recherche")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							<X className="h-3 w-3" />
						</button>
					)}
				</div>
			</div>

			<div className="flex-1 overflow-y-auto pr-0.5">
				<div className="mb-1.5">
					<div className="flex items-center">
						<button
							type="button"
							onClick={() => toggle("myBricks")}
							aria-expanded={myBricksOpen}
							className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronRight
								className={`h-3 w-3 shrink-0 transition-transform ${myBricksOpen ? "rotate-90" : ""}`}
							/>
							<span className="truncate">{t("myBricks", "Mes briques")}</span>
							<span className="ml-auto tabular-nums opacity-60">
								{shownBricks.length}
							</span>
						</button>
						<button
							type="button"
							onClick={() => setEditor({ open: true, brick: null })}
							title={t("brickCreateTitle", "Nouvelle brique")}
							aria-label={t("brickCreateTitle", "Nouvelle brique")}
							className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					</div>
					{myBricksOpen ? (
						<div className="mt-0.5 flex flex-col gap-0.5 pl-1">
							{shownBricks.map(renderBrick)}
							{bricks.length === 0 ? (
								<button
									type="button"
									onClick={() => setEditor({ open: true, brick: null })}
									className="flex items-center gap-2 rounded-md border border-dashed px-2 py-2 text-left text-3xs leading-snug text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
								>
									<Plus className="h-3.5 w-3.5 shrink-0" />
									{t(
										"myBricksEmpty",
										"Créez vos propres briques : un agent, un moteur métier, un système existant…",
									)}
								</button>
							) : null}
						</div>
					) : null}
				</div>
				{categories.length === 0 && shownBricks.length === 0 ? (
					<p className="px-2 py-6 text-center text-xs text-muted-foreground">
						{t("noBlockMatch", "Aucun bloc ne correspond.")}
					</p>
				) : (
					categories.map((cat) => {
						// A search that narrowed the list should show its results, not
						// whatever the user had folded away before typing.
						const isOpen = query ? true : !collapsed[cat.labelKey];
						return (
							<div key={cat.labelKey} className="mb-1.5">
								<button
									type="button"
									onClick={() => toggle(cat.labelKey)}
									aria-expanded={isOpen}
									className="flex w-full items-center gap-1 rounded px-1 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
								>
									<ChevronRight
										className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
									/>
									<span className="truncate">{t(cat.labelKey)}</span>
									<span className="ml-auto tabular-nums opacity-60">
										{cat.blocks.length}
									</span>
								</button>
								{isOpen && (
									<div className="mt-0.5 flex flex-col gap-0.5 pl-1">
										{cat.blocks.map(renderBlock)}
									</div>
								)}
							</div>
						);
					})
				)}
			</div>

			<p className="shrink-0 border-t px-1 pt-2 text-3xs leading-snug text-muted-foreground">
				{t("paletteHint", "Glissez un bloc sur le canvas, ou cliquez-le.")}
			</p>
			<BrickEditorDialog
				open={editor.open}
				brick={editor.brick}
				onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
			/>
		</div>
	);
};

export { BLOCK_CATEGORIES };
