import { Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Handle, type NodeProps, Position } from "reactflow";
import { blockMeta } from "../lib/architecture-blocks";

export interface EditableNodeData {
	label?: string;
	type?: string;
	framework?: string;
	onRename?: (id: string, label: string) => void;
	onDelete?: (id: string) => void;
}

/**
 * A block on the canvas.
 *
 * Renders what the block *is* — the palette's icon and accent, the role, the
 * chosen stack — instead of a bare rounded rectangle with a name in it. On a
 * ten-block diagram the accent is what lets you find the database without
 * reading every label.
 *
 * Handles are Left (in) / Right (out) rather than Top / Bottom: the connection
 * rules encode a request direction, and a left-to-right diagram makes drawing
 * the arrow the wrong way visibly wrong.
 */
export const EditableNode: React.FC<NodeProps<EditableNodeData>> = ({
	id,
	data,
	selected,
	dragging,
}) => {
	const { t } = useTranslation("visualProgramming");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(data.label ?? "");
	const inputRef = useRef<HTMLInputElement>(null);
	const meta = blockMeta(data.type);
	const Icon = meta?.icon;
	const accent = meta?.accent ?? "var(--primary, #6366f1)";

	// The label is owned by the canvas. Re-sync whenever it changes there —
	// undo, an import, or a rename from the inspector — so the node never shows
	// a value the diagram no longer holds.
	useEffect(() => {
		if (!editing) setDraft(data.label ?? "");
	}, [data.label, editing]);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		// An empty name would leave an anonymous box behind; keep the old one.
		if (next.length === 0) {
			setDraft(data.label ?? "");
			return;
		}
		if (next !== data.label) data.onRename?.(id, next);
	};

	const cancel = () => {
		setDraft(data.label ?? "");
		setEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// The canvas deletes the selection on Delete/Backspace. Without this the
		// node being renamed is destroyed by its own first correction keystroke.
		e.stopPropagation();
		if (e.key === "Enter") commit();
		if (e.key === "Escape") cancel();
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename is the canvas idiom
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: double-click to rename is the canvas idiom
		<div
			onDoubleClick={() => setEditing(true)}
			className="group relative rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow"
			style={{
				minWidth: 172,
				borderColor: selected ? accent : "var(--border, #33333a)",
				borderWidth: selected ? 2 : 1,
				boxShadow: selected
					? `0 0 0 3px color-mix(in srgb, ${accent} 22%, transparent)`
					: dragging
						? "0 8px 20px rgba(0,0,0,0.22)"
						: undefined,
			}}
		>
			<Handle
				type="target"
				position={Position.Left}
				style={{
					width: 9,
					height: 9,
					background: "var(--card, #17171b)",
					border: `2px solid ${accent}`,
				}}
			/>

			<div className="flex items-center gap-2.5 px-2.5 py-2">
				<span
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
					style={{
						backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`,
						color: accent,
					}}
				>
					{Icon ? <Icon className="h-4 w-4" /> : null}
				</span>
				<div className="min-w-0 flex-1">
					{editing ? (
						<input
							ref={inputRef}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onBlur={commit}
							onKeyDown={handleKeyDown}
							className="nodrag w-full rounded border bg-background px-1 py-0.5 text-[13px] font-semibold text-foreground outline-none"
							style={{ borderColor: accent }}
							aria-label={String(data.label ?? "")}
						/>
					) : (
						<p className="truncate text-[13px] font-semibold leading-tight">
							{data.label}
						</p>
					)}
					{data.framework ? (
						<p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">
							{data.framework}
						</p>
					) : null}
				</div>
				{data.onDelete ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							data.onDelete?.(id);
						}}
						title={t("deleteBlock", "Supprimer le bloc")}
						className="nodrag shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
					>
						<Trash2 className="h-3 w-3" />
					</button>
				) : null}
			</div>

			<Handle
				type="source"
				position={Position.Right}
				style={{
					width: 9,
					height: 9,
					background: "var(--card, #17171b)",
					border: `2px solid ${accent}`,
				}}
			/>
		</div>
	);
};
